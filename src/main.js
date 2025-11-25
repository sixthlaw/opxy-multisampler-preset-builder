import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { PitchDetector } from 'pitchy';
import Pitchfinder from 'pitchfinder';

// Quality presets - 44100 Hz is what working presets use
const QUALITY_PRESETS = {
  standard: { sampleRate: 44100 },
  high: { sampleRate: 48000 },
  lofi: { sampleRate: 22050 }
};

// Sample density presets - based on multisampling best practices
// Interval is the target semitone spacing between samples
const DENSITY_PRESETS = {
  full: {
    maxSamples: 24,
    interval: 4,  // Major third - highest quality
    description: 'Every major 3rd'
  },
  balanced: {
    maxSamples: 12,
    interval: 7,  // Perfect fifth - good balance
    description: 'Every perfect 5th'
  },
  lite: {
    maxSamples: 5,
    interval: 14, // Just over an octave - relies on pitch shifting
    description: 'Every octave+'
  }
};

// MIDI note names for detection
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_ALIASES = { 'Db': 'C#', 'Eb': 'D#', 'Fb': 'E', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#', 'Cb': 'B' };

// Grouping patterns for velocity layers, round-robins, etc.
const GROUPING_PATTERNS = [
  // Round-robin patterns
  { regex: /_RR(\d+)$/i, type: 'round-robin', label: 'Round Robin' },
  { regex: /-RR(\d+)$/i, type: 'round-robin', label: 'Round Robin' },
  { regex: /_R(\d+)$/i, type: 'round-robin', label: 'Round Robin' },

  // Velocity layers (descriptive)
  { regex: /[_-](fff)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](ff)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](f)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](mf)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](mp)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](p)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](pp)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](ppp)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /[_-](hard|medium|soft|light)$/i, type: 'velocity', label: 'Velocity Layer' },

  // Velocity layers (numeric)
  { regex: /_V(\d+)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /-V(\d+)$/i, type: 'velocity', label: 'Velocity Layer' },
  { regex: /_L(\d+)$/i, type: 'layer', label: 'Layer' },
  { regex: /-L(\d+)$/i, type: 'layer', label: 'Layer' },
];

// App state
const state = {
  files: [],
  samples: [],
  presetName: '',
  quality: 'standard',
  density: 'balanced',
  warnings: [],
  zipBlob: null,
  totalSize: 0,
  // Assignment screen state
  currentOctave: 4,
  unassignedSamples: [],
  processedSamples: [],
  audioContext: null,
  currentPlayingSource: null,
  // Grouping state
  detectedPattern: null,  // { type, label, groups: { 'RR1': [files], 'RR2': [files] } }
  useGrouping: false,
  groupedPresets: [],  // Array of { name, samples, patch, sampleFiles }
  groupedProcessedSamples: {}  // { groupKey: [processed samples] } for note assignment
};

// DOM Elements
const screens = {
  upload: document.getElementById('screen-upload'),
  assign: document.getElementById('screen-assign'),
  processing: document.getElementById('screen-processing'),
  complete: document.getElementById('screen-complete')
};

// Step elements for onboarding flow
const steps = {
  samples: document.getElementById('step-samples'),
  grouping: document.getElementById('step-grouping'),
  quality: document.getElementById('step-quality'),
  bitdepth: document.getElementById('step-bitdepth'),
  density: document.getElementById('step-density'),
  name: document.getElementById('step-name')
};

const elements = {
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  fileList: document.getElementById('file-list'),
  fileCount: document.getElementById('file-count'),
  fileListUl: document.getElementById('files'),
  clearFiles: document.getElementById('clear-files'),
  presetName: document.getElementById('preset-name'),
  qualityInputs: document.querySelectorAll('input[name="quality"]'),
  bitDepthInputs: document.querySelectorAll('input[name="bitdepth"]'),
  densityRecommendation: document.getElementById('density-recommendation'),
  densityInputs: document.querySelectorAll('input[name="density"]'),
  densityFullDesc: document.getElementById('density-full-desc'),
  densityBalancedDesc: document.getElementById('density-balanced-desc'),
  densityLiteDesc: document.getElementById('density-lite-desc'),
  warnings: document.getElementById('warnings'),
  createBtn: document.getElementById('create-btn'),
  processingStatus: document.getElementById('processing-status'),
  completeTitle: document.getElementById('complete-title'),
  downloadBtn: document.getElementById('download-btn'),
  presetInfo: document.getElementById('preset-info'),
  restartBtn: document.getElementById('restart-btn'),
  // Step continue buttons
  step1Continue: document.getElementById('step1-continue'),
  step2Continue: document.getElementById('step2-continue'),
  step3Continue: document.getElementById('step3-continue'),
  step4Continue: document.getElementById('step4-continue'),
  // Grouping elements
  groupCount: document.getElementById('group-count'),
  patternType: document.getElementById('pattern-type'),
  groupPreview: document.getElementById('group-preview'),
  useGrouping: document.getElementById('use-grouping'),
  skipGrouping: document.getElementById('skip-grouping'),
  // Assignment screen elements
  keyboard: document.getElementById('keyboard'),
  octaveDown: document.getElementById('octave-down'),
  octaveUp: document.getElementById('octave-up'),
  currentOctave: document.getElementById('current-octave'),
  playedNote: document.getElementById('played-note'),
  assignCount: document.getElementById('assign-count'),
  unassignedList: document.getElementById('unassigned-list'),
  finishAssignBtn: document.getElementById('finish-assign-btn')
};

// Screen Management
function showScreen(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');
}

// Step Management for onboarding flow
let currentStep = 1;
let showingGroupingStep = false;

function showStep(stepNumber, isGroupingStep = false) {
  // Standard step order (grouping is conditional, inserted between 1 and 2)
  const stepOrder = ['samples', 'quality', 'bitdepth', 'density', 'name'];

  // Handle grouping step visibility
  steps.grouping.classList.remove('visible', 'completed');
  if (isGroupingStep) {
    steps.grouping.classList.add('visible');
    showingGroupingStep = true;
    // Hide all other steps
    stepOrder.forEach(stepName => {
      steps[stepName].classList.remove('visible', 'completed');
      if (stepName === 'samples') {
        steps[stepName].classList.add('completed');
      }
    });
    currentStep = 1.5;
    return;
  }

  showingGroupingStep = false;

  stepOrder.forEach((stepName, index) => {
    const step = steps[stepName];
    const stepNum = index + 1;

    step.classList.remove('visible', 'completed');

    if (stepNum < stepNumber) {
      step.classList.add('completed');
    } else if (stepNum === stepNumber) {
      step.classList.add('visible');
    }
    // Steps after current remain hidden (no class)
  });

  currentStep = stepNumber;
}

function advanceStep() {
  const fileCount = state.files.length;

  // From step 1 (samples), check for grouping patterns
  if (currentStep === 1) {
    const detection = detectGroupingPatterns(state.files);

    if (detection) {
      const groupCount = Object.keys(detection.groups).length;

      // If multiple groups detected, show confirmation
      if (groupCount > 1) {
        state.detectedPattern = detection;
        showGroupingConfirmation(detection);
        return;
      }
    }

    // No patterns or only one group - proceed to quality
    state.detectedPattern = null;
    state.useGrouping = false;
    showStep(2);
    return;
  }

  // From grouping step, proceed to quality (handled by button handlers)
  if (currentStep === 1.5) {
    showStep(2);
    return;
  }

  // From step 3 (bit depth), check if we need density step
  if (currentStep === 3) {
    // Count total files across all groups if grouping is enabled
    let totalFiles = fileCount;
    if (state.useGrouping && state.detectedPattern) {
      // For grouped presets, check if any group has many files
      const maxGroupSize = Math.max(...Object.values(state.detectedPattern.groups).map(g => g.length));
      totalFiles = maxGroupSize;
    }

    if (totalFiles >= 6) {
      // Show density step
      updateDensityInfo();
      showStep(4);
    } else {
      // Skip to name step
      showStep(5);
    }
  } else if (currentStep === 4) {
    // After density, go to name
    showStep(5);
  } else {
    showStep(currentStep + 1);
  }
}

function showGroupingConfirmation(detection) {
  const groupKeys = Object.keys(detection.groups).sort();

  // Update the UI
  elements.groupCount.textContent = groupKeys.length;
  elements.patternType.textContent = detection.label.toLowerCase();

  // Generate group preview cards
  elements.groupPreview.innerHTML = groupKeys.map(key => {
    const count = detection.groups[key].length;
    return `
      <div class="group-card">
        <span class="group-card-name">${key}</span>
        <span class="group-card-count">${count} sample${count !== 1 ? 's' : ''}</span>
      </div>
    `;
  }).join('');

  // Show the grouping step
  showStep(1.5, true);
}

function updateDensityInfo() {
  const fileCount = state.files.length;

  // Calculate how many samples each tier would use
  const fullCount = Math.min(fileCount, DENSITY_PRESETS.full.maxSamples);
  const balancedCount = Math.min(fileCount, DENSITY_PRESETS.balanced.maxSamples);
  const liteCount = Math.min(fileCount, DENSITY_PRESETS.lite.maxSamples);

  // Update descriptions with actual counts
  elements.densityFullDesc.textContent = `${fullCount} samples`;
  elements.densityBalancedDesc.textContent = `${balancedCount} samples`;
  elements.densityLiteDesc.textContent = `${liteCount} samples`;

  // Generate recommendation message
  let recommendation = '';
  if (fileCount > 24) {
    recommendation = `${fileCount} samples uploaded. OP-XY supports max 24. We'll select the best spread.`;
  } else if (fileCount > 12) {
    recommendation = `${fileCount} samples. Balanced offers great quality with smaller file size.`;
  } else {
    recommendation = `${fileCount} samples. The OP-XY will smoothly blend between them.`;
  }
  elements.densityRecommendation.textContent = recommendation;
}

// Pattern Detection for Batch Grouping
function detectGroupingPatterns(files) {
  // Try each pattern and see if it matches any files
  const patternMatches = [];

  for (const pattern of GROUPING_PATTERNS) {
    const groups = {};
    const matched = [];

    for (const file of files) {
      // Remove extension for pattern matching
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      const match = baseName.match(pattern.regex);

      if (match) {
        const groupKey = match[1].toUpperCase();
        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push(file);
        matched.push(file);
      }
    }

    const groupKeys = Object.keys(groups);
    // Only consider this pattern if it matches multiple files AND creates multiple groups
    if (groupKeys.length >= 2 && matched.length >= 4) {
      patternMatches.push({
        pattern,
        groups,
        matchedCount: matched.length,
        groupCount: groupKeys.length
      });
    }
  }

  // No patterns found
  if (patternMatches.length === 0) {
    return null;
  }

  // Pick the best pattern (most files matched, then most groups)
  patternMatches.sort((a, b) => {
    if (b.matchedCount !== a.matchedCount) {
      return b.matchedCount - a.matchedCount;
    }
    return b.groupCount - a.groupCount;
  });

  const best = patternMatches[0];
  return {
    type: best.pattern.type,
    label: best.pattern.label,
    groups: best.groups
  };
}

// Get base filename without the grouping suffix (for note detection)
function getBaseNameWithoutGroupSuffix(filename, patternInfo) {
  if (!patternInfo) return filename;

  // Find which pattern matched
  const baseName = filename.replace(/\.[^/.]+$/, '');

  for (const pattern of GROUPING_PATTERNS) {
    if (pattern.type === patternInfo.type) {
      const match = baseName.match(pattern.regex);
      if (match) {
        // Return the filename with the suffix removed
        return baseName.replace(pattern.regex, '') + filename.match(/\.[^/.]+$/)?.[0] || '';
      }
    }
  }

  return filename;
}

// Note Detection from Filename (improved to handle more patterns)
function parseNoteFromFilename(filename) {
  // Remove extension
  const name = filename.replace(/\.[^/.]+$/, '');

  // Pattern 1: Note name ANYWHERE in filename (C4, F#3, Bb2, etc.)
  // Matches: "C#3.wav", "pianotest3-A3.wav", "Piano_F#4_loud.wav"
  const noteRegex = /([A-Ga-g][#b]?)(-?\d)/gi;
  const matches = [...name.matchAll(noteRegex)];

  if (matches.length > 0) {
    // Use the last match (most likely to be the note indicator)
    const match = matches[matches.length - 1];
    let noteName = match[1].toUpperCase();
    const octave = parseInt(match[2], 10);

    // Handle flat aliases
    if (NOTE_ALIASES[noteName]) {
      noteName = NOTE_ALIASES[noteName];
    }

    const noteIndex = NOTE_NAMES.indexOf(noteName);
    if (noteIndex !== -1 && octave >= -1 && octave <= 9) {
      // MIDI note: (octave + 1) * 12 + noteIndex
      // C4 = 60, so C0 = 12
      return (octave + 1) * 12 + noteIndex;
    }
  }

  // Pattern 2: MIDI note number (21-108 = piano range)
  const midiMatch = name.match(/\b(\d{1,3})\b/);
  if (midiMatch) {
    const midi = parseInt(midiMatch[1], 10);
    if (midi >= 21 && midi <= 108) {
      return midi;
    }
  }

  return null; // Could not detect
}

// Pitch detection using pitchy (McLeod Pitch Method) - most accurate
function detectPitchWithPitchy(samples, sampleRate) {
  const samplesToAnalyze = Math.min(samples.length, sampleRate);
  const segment = samples.slice(0, samplesToAnalyze);

  try {
    const detector = PitchDetector.forFloat32Array(segment.length);
    const [pitch, clarity] = detector.findPitch(segment, sampleRate);

    if (pitch && clarity > 0.8 && pitch > 20 && pitch < 5000) {
      const midiNote = Math.round(12 * Math.log2(pitch / 440) + 69);
      if (midiNote >= 21 && midiNote <= 108) {
        return { midiNote, clarity, method: 'pitchy' };
      }
    }
  } catch (e) {
    console.warn('Pitchy detection failed:', e);
  }
  return null;
}

// Pitch detection using pitchfinder (YIN algorithm) - fallback
function detectPitchWithPitchfinder(samples, sampleRate) {
  const detectPitch = Pitchfinder.YIN({ sampleRate });

  // Analyze first second
  const samplesToAnalyze = Math.min(samples.length, sampleRate);
  const segment = samples.slice(0, samplesToAnalyze);

  try {
    const frequency = detectPitch(segment);

    if (frequency && frequency > 20 && frequency < 5000) {
      const midiNote = Math.round(12 * Math.log2(frequency / 440) + 69);
      if (midiNote >= 21 && midiNote <= 108) {
        return { midiNote, method: 'pitchfinder' };
      }
    }
  } catch (e) {
    console.warn('Pitchfinder detection failed:', e);
  }
  return null;
}

// Combined audio pitch detection with fallback
function detectPitchFromAudio(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;

  // Get mono channel data
  let samples;
  if (audioBuffer.numberOfChannels === 1) {
    samples = new Float32Array(audioBuffer.getChannelData(0));
  } else {
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    samples = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      samples[i] = (left[i] + right[i]) / 2;
    }
  }

  // Try pitchy first (most accurate for tonal instruments)
  let result = detectPitchWithPitchy(samples, sampleRate);
  if (result) return result;

  // Fall back to pitchfinder (YIN) if pitchy fails
  result = detectPitchWithPitchfinder(samples, sampleRate);
  if (result) return result;

  return null;
}

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const note = NOTE_NAMES[midi % 12];
  return `${note}${octave}`;
}

function noteNameToMidi(noteName) {
  const match = noteName.match(/^([A-Ga-g][#b]?)(-?\d)$/);
  if (!match) return null;

  let note = match[1].toUpperCase();
  const octave = parseInt(match[2], 10);

  if (NOTE_ALIASES[note]) {
    note = NOTE_ALIASES[note];
  }

  const noteIndex = NOTE_NAMES.indexOf(note);
  if (noteIndex === -1 || octave < -1 || octave > 9) return null;

  return (octave + 1) * 12 + noteIndex;
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Keyboard & Audio Functions
function getAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioContext;
}

function stopCurrentSound() {
  if (state.currentPlayingSource) {
    try {
      state.currentPlayingSource.stop();
    } catch (e) {
      // Ignore - already stopped
    }
    state.currentPlayingSource = null;
  }
}

async function playTone(midiNote, duration = 0.5) {
  stopCurrentSound();

  const ctx = getAudioContext();

  // Resume context if suspended (browser autoplay policy)
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const frequency = midiToFrequency(midiNote);

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;

  gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start();
  oscillator.stop(ctx.currentTime + duration);

  state.currentPlayingSource = oscillator;

  // Update display
  elements.playedNote.textContent = midiToNoteName(midiNote);
}

async function playSampleBuffer(audioBuffer) {
  stopCurrentSound();

  const ctx = getAudioContext();

  // Resume context if suspended (browser autoplay policy)
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  source.start();

  state.currentPlayingSource = source;
}

function generateKeyboard() {
  elements.keyboard.innerHTML = '';

  const baseOctave = state.currentOctave;
  const startMidi = (baseOctave + 1) * 12; // C of current octave

  // Create one octave of keys (C to B)
  const whiteNotes = [0, 2, 4, 5, 7, 9, 11]; // C, D, E, F, G, A, B
  const blackNotes = [1, 3, 6, 8, 10]; // C#, D#, F#, G#, A#

  const whiteKeyWidth = 34;
  const blackKeyWidth = 24;

  // Create white keys first
  whiteNotes.forEach((offset, index) => {
    const midi = startMidi + offset;
    const key = document.createElement('button');
    key.className = 'key white';
    key.dataset.midi = midi;
    key.dataset.note = midiToNoteName(midi);
    key.style.left = `${index * whiteKeyWidth}px`;
    key.innerHTML = `<span>${NOTE_NAMES[offset]}</span>`;
    key.addEventListener('click', () => {
      playTone(midi);
      highlightKey(key);
      fillFirstNoteInput(midiToNoteName(midi));
    });
    elements.keyboard.appendChild(key);
  });

  // Black key positions (pixels from left edge)
  // C#: between C and D (index 0-1) -> 34 - 12 = 22
  // D#: between D and E (index 1-2) -> 68 - 12 = 56
  // F#: between F and G (index 3-4) -> 136 - 12 = 124
  // G#: between G and A (index 4-5) -> 170 - 12 = 158
  // A#: between A and B (index 5-6) -> 204 - 12 = 192
  const blackKeyPositions = [22, 56, 124, 158, 192];

  blackNotes.forEach((offset, index) => {
    const midi = startMidi + offset;
    const key = document.createElement('button');
    key.className = 'key black';
    key.dataset.midi = midi;
    key.dataset.note = midiToNoteName(midi);
    key.style.left = `${blackKeyPositions[index]}px`;
    key.addEventListener('click', () => {
      playTone(midi);
      highlightKey(key);
      fillFirstNoteInput(midiToNoteName(midi));
    });
    elements.keyboard.appendChild(key);
  });

  elements.currentOctave.textContent = `C${baseOctave}`;
}

function highlightKey(key) {
  elements.keyboard.querySelectorAll('.key').forEach(k => k.classList.remove('active'));
  key.classList.add('active');
  setTimeout(() => key.classList.remove('active'), 300);
}

function updateOctave(delta) {
  state.currentOctave = Math.max(0, Math.min(8, state.currentOctave + delta));
  generateKeyboard();
}

function fillFirstNoteInput(noteName) {
  const firstInput = elements.unassignedList.querySelector('.note-input');
  if (firstInput) {
    firstInput.value = noteName;
    firstInput.focus();
  }
}

function renderUnassignedSamples() {
  const count = state.unassignedSamples.length;
  elements.assignCount.textContent = `${count} sample${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} assignment`;

  elements.unassignedList.innerHTML = state.unassignedSamples.map((sample, index) => `
    <div class="unassigned-item" data-index="${index}">
      <button class="play-btn" data-index="${index}" title="Play sample">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2l10 6-10 6V2z"/>
        </svg>
      </button>
      <span class="sample-name">${escapeHtml(sample.originalName)}</span>
      <input type="text" class="note-input" data-index="${index}" placeholder="C4" maxlength="4">
      <button class="assign-btn" data-index="${index}">Set</button>
      <button class="remove-btn" data-index="${index}" title="Remove sample">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="4" y1="4" x2="12" y2="12"/>
          <line x1="12" y1="4" x2="4" y2="12"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Add event listeners
  elements.unassignedList.querySelectorAll('.play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      playSample(idx);
    });
  });

  elements.unassignedList.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      assignNote(idx);
    });
  });

  elements.unassignedList.querySelectorAll('.note-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const idx = parseInt(e.target.dataset.index, 10);
        assignNote(idx);
      }
    });
  });

  elements.unassignedList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      removeSample(idx);
    });
  });
}

async function playSample(index) {
  const sample = state.unassignedSamples[index];
  if (!sample || !sample.audioBuffer) return;

  playSampleBuffer(sample.audioBuffer);
}

function assignNote(index) {
  const input = elements.unassignedList.querySelector(`.note-input[data-index="${index}"]`);
  const noteValue = input.value.trim();

  if (!noteValue) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 500);
    return;
  }

  const midiNote = noteNameToMidi(noteValue);
  if (midiNote === null) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 500);
    return;
  }

  // Update the sample with the assigned note
  const sample = state.unassignedSamples[index];
  sample.rootNote = midiNote;
  sample.detectionMethod = 'manual';

  // Move from unassigned to processed
  const assignedSample = state.unassignedSamples.splice(index, 1)[0];
  state.processedSamples.push(assignedSample);

  // Re-render the list
  renderUnassignedSamples();

  // If all samples assigned, enable finish button
  elements.finishAssignBtn.disabled = false;
}

function removeSample(index) {
  // Remove the sample from the unassigned list (it won't be included in the preset)
  state.unassignedSamples.splice(index, 1);

  // Re-render the list
  renderUnassignedSamples();

  // Update button state - if no unassigned samples left and no processed samples, disable
  const totalSamples = state.unassignedSamples.length + state.processedSamples.length;
  elements.finishAssignBtn.disabled = totalSamples === 0;
}

function showAssignmentScreen(unassigned) {
  state.unassignedSamples = unassigned;
  generateKeyboard();
  renderUnassignedSamples();
  elements.finishAssignBtn.disabled = false;
  showScreen('assign');
}

function finishAssignment() {
  // For any remaining unassigned samples, use auto-assignment
  const stillUnassigned = state.unassignedSamples.length;
  if (stillUnassigned > 0) {
    state.warnings.push(`${stillUnassigned} sample${stillUnassigned > 1 ? 's' : ''} assigned automatically`);
  }

  // Check if we're in grouped mode
  if (state.useGrouping && state.groupedProcessedSamples && Object.keys(state.groupedProcessedSamples).length > 0) {
    // Put the assigned/unassigned samples back into their groups
    const allAssigned = [...state.processedSamples, ...state.unassignedSamples];

    // Update each group with the newly assigned samples
    for (const sample of allAssigned) {
      if (sample.groupKey && state.groupedProcessedSamples[sample.groupKey]) {
        // Find and update the sample in its group
        const groupSamples = state.groupedProcessedSamples[sample.groupKey];
        const idx = groupSamples.findIndex(s => s.originalName === sample.originalName);
        if (idx !== -1) {
          groupSamples[idx] = sample;
        }
      }
    }

    // Continue with grouped preset building
    showScreen('processing');
    elements.processingStatus.textContent = 'Building presets...';
    finishGroupedPresets(state.density);
    return;
  }

  // Non-grouped mode: combine all processed samples
  const allSamples = [...state.processedSamples, ...state.unassignedSamples];

  // Continue with the rest of the processing
  continueProcessing(allSamples);
}

// File Handling
function handleFiles(files) {
  const audioFiles = Array.from(files).filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['wav', 'aiff', 'aif', 'mp3', 'm4a', 'flac', 'ogg', 'webm'].includes(ext) ||
           f.type.startsWith('audio/');
  });

  if (audioFiles.length === 0) {
    return;
  }

  // Add to existing files (dedupe by name)
  const existingNames = new Set(state.files.map(f => f.name));
  audioFiles.forEach(f => {
    if (!existingNames.has(f.name)) {
      state.files.push(f);
    }
  });

  updateFileList();
  updateCreateButton();
  updateDensitySection();
}

function updateFileList() {
  if (state.files.length === 0) {
    elements.fileList.classList.add('hidden');
    elements.dropZone.classList.remove('has-files');
    return;
  }

  elements.fileList.classList.remove('hidden');
  elements.dropZone.classList.add('has-files');
  elements.fileCount.textContent = `${state.files.length} sample${state.files.length !== 1 ? 's' : ''}`;

  elements.fileListUl.innerHTML = state.files.map((f, i) => {
    const note = parseNoteFromFilename(f.name);
    const noteDisplay = note !== null
      ? `<span class="file-note detected">${midiToNoteName(note)}</span>`
      : '<span class="file-note">auto</span>';
    return `<li><span class="file-name">${escapeHtml(f.name)}</span>${noteDisplay}</li>`;
  }).join('');
}

function clearFiles() {
  state.files = [];
  elements.fileInput.value = '';
  updateFileList();
  updateCreateButton();
  updateDensitySection();
}

function updateCreateButton() {
  // Enable step 1 continue button when files are added
  elements.step1Continue.disabled = state.files.length === 0;
}

function updateDensitySection() {
  // This function is now handled by updateDensityInfo() in the step flow
  // Kept for compatibility but does nothing in new flow
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Audio Processing
async function decodeAudioFile(file) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const arrayBuffer = await file.arrayBuffer();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    audioContext.close();
    return audioBuffer;
  } catch (e) {
    audioContext.close();
    throw new Error(`Could not decode ${file.name}`);
  }
}

// High-quality resampling using Web Audio API's OfflineAudioContext
// This uses band-limited interpolation with anti-aliasing (industry standard)
async function resampleWithWebAudio(audioBuffer, targetSampleRate) {
  if (audioBuffer.sampleRate === targetSampleRate) {
    return audioBuffer;
  }

  const offlineCtx = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    Math.ceil(audioBuffer.duration * targetSampleRate),
    targetSampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  return await offlineCtx.startRendering();
}

// Stereo audio processing functions
// Detect transient onset using energy derivative method
// Returns sample index of the transient attack
function detectTransient(left, right, sampleRate) {
  // Analysis window: ~3ms for transient detection (good for percussive and tonal)
  const windowSize = Math.floor(sampleRate * 0.003);
  const hopSize = Math.floor(windowSize / 2);

  // Calculate RMS energy for each window
  const energies = [];
  for (let i = 0; i + windowSize < left.length; i += hopSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const l = left[i + j];
      const r = right[i + j];
      // Use max of L/R for transient detection
      const sample = Math.max(Math.abs(l), Math.abs(r));
      sum += sample * sample;
    }
    energies.push({
      index: i,
      rms: Math.sqrt(sum / windowSize)
    });
  }

  if (energies.length < 3) {
    return null;
  }

  // Calculate energy derivative (rate of change)
  const derivatives = [];
  for (let i = 1; i < energies.length; i++) {
    derivatives.push({
      index: energies[i].index,
      delta: energies[i].rms - energies[i - 1].rms,
      rms: energies[i].rms
    });
  }

  // Find the maximum energy in the sample to set adaptive threshold
  const maxEnergy = Math.max(...energies.map(e => e.rms));
  if (maxEnergy === 0) {
    return null;
  }

  // Transient threshold: significant jump relative to max energy
  // Using 5% of max energy as minimum delta for a transient
  const transientThreshold = maxEnergy * 0.05;

  // Also require absolute RMS to be above noise floor (-50dB)
  const noiseFloor = Math.pow(10, -50 / 20);

  // Find first significant positive energy jump (transient attack)
  for (let i = 0; i < derivatives.length; i++) {
    const d = derivatives[i];
    if (d.delta > transientThreshold && d.rms > noiseFloor) {
      // Found transient - return the index of the previous window
      // This gives us the moment just before the attack
      return energies[i].index;
    }
  }

  return null;
}

function trimSilenceStereo(left, right, sampleRate, thresholdDb = -50) {
  const threshold = Math.pow(10, thresholdDb / 20);
  const minLengthSamples = sampleRate * 0.5;
  const tailPadding = Math.floor(sampleRate * 0.5);

  // Pre-attack padding: ~2ms before transient to preserve attack character
  const preAttackSamples = Math.floor(sampleRate * 0.002);

  let start = 0;
  let end = left.length - 1;

  // Try transient detection first (best for percussive/plucked sounds)
  const transientStart = detectTransient(left, right, sampleRate);

  if (transientStart !== null) {
    // Back up slightly before the transient to preserve the natural attack
    start = Math.max(0, transientStart - preAttackSamples);
  } else {
    // Fallback: find first sample above threshold
    // This handles soft/sustained sounds without clear transients
    for (let i = 0; i < left.length; i++) {
      if (Math.abs(left[i]) > threshold || Math.abs(right[i]) > threshold) {
        start = Math.max(0, i - preAttackSamples);
        break;
      }
    }
  }

  // Find end using amplitude threshold (unchanged - this works well)
  for (let i = left.length - 1; i >= 0; i--) {
    if (Math.abs(left[i]) > threshold || Math.abs(right[i]) > threshold) {
      end = Math.min(left.length - 1, i + tailPadding);
      break;
    }
  }

  const trimmedLength = end - start + 1;
  if (trimmedLength < minLengthSamples && left.length >= minLengthSamples) {
    end = Math.min(left.length - 1, start + minLengthSamples);
  }

  if (start >= end) {
    return { left, right };
  }

  return {
    left: left.slice(start, end + 1),
    right: right.slice(start, end + 1)
  };
}

function normalizeStereo(left, right, targetDb = -1) {
  // Find max across both channels
  let max = 0;
  for (let i = 0; i < left.length; i++) {
    max = Math.max(max, Math.abs(left[i]), Math.abs(right[i]));
  }

  if (max === 0) return { left, right };

  const targetLinear = Math.pow(10, targetDb / 20);
  const gain = targetLinear / max;

  const leftResult = new Float32Array(left.length);
  const rightResult = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) {
    leftResult[i] = left[i] * gain;
    rightResult[i] = right[i] * gain;
  }
  return { left: leftResult, right: rightResult };
}

async function applyLimiter(left, right, sampleRate) {
  const length = left.length;

  // Create offline context for processing
  const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

  // Create buffer from our samples
  const buffer = offlineCtx.createBuffer(2, length, sampleRate);
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);

  // Create source and limiter
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;

  // DynamicsCompressor configured as a transparent limiter
  const limiter = offlineCtx.createDynamicsCompressor();
  limiter.threshold.value = -0.5;  // dB - catch peaks just below 0
  limiter.knee.value = 0;          // Hard knee for transparent limiting
  limiter.ratio.value = 20;        // High ratio = limiting behavior
  limiter.attack.value = 0.001;    // 1ms - fast attack
  limiter.release.value = 0.010;   // 10ms - quick release

  // Connect: source → limiter → destination
  source.connect(limiter);
  limiter.connect(offlineCtx.destination);
  source.start(0);

  // Render and extract channels
  const limitedBuffer = await offlineCtx.startRendering();
  return {
    left: limitedBuffer.getChannelData(0),
    right: limitedBuffer.getChannelData(1)
  };
}

function applyFadesStereo(left, right, sampleRate, fadeInMs = 5, fadeOutPercent = 0.10) {
  const fadeInSamples = Math.floor(sampleRate * fadeInMs / 1000);
  // Fade out is 10% of total sample length for clean endings
  const fadeOutSamples = Math.floor(left.length * fadeOutPercent);

  const leftResult = new Float32Array(left);
  const rightResult = new Float32Array(right);

  // Fade in (short, just to avoid clicks)
  for (let i = 0; i < fadeInSamples && i < leftResult.length; i++) {
    const fade = i / fadeInSamples;
    leftResult[i] *= fade;
    rightResult[i] *= fade;
  }

  // Fade out (10% of sample length for smooth endings)
  // Using equal-power fade curve for more natural sound
  for (let i = 0; i < fadeOutSamples && i < leftResult.length; i++) {
    const idx = leftResult.length - 1 - i;
    // Equal-power curve: cos^2 for smoother fade
    const t = i / fadeOutSamples;
    const fade = Math.cos((1 - t) * Math.PI / 2);
    leftResult[idx] *= fade;
    rightResult[idx] *= fade;
  }

  return { left: leftResult, right: rightResult };
}

function truncateWithFadeStereo(left, right, sampleRate, maxDuration) {
  const maxSamples = Math.floor(sampleRate * maxDuration);

  if (left.length <= maxSamples) {
    return { left, right };
  }

  const leftResult = left.slice(0, maxSamples);
  const rightResult = right.slice(0, maxSamples);

  // Apply fade out at the end
  const fadeOutSamples = Math.floor(sampleRate * 0.05);
  for (let i = 0; i < fadeOutSamples; i++) {
    const idx = leftResult.length - 1 - i;
    const fade = i / fadeOutSamples;
    leftResult[idx] *= fade;
    rightResult[idx] *= fade;
  }

  return { left: leftResult, right: rightResult };
}

function floatTo16BitPCMStereo(left, right) {
  // Interleave L-R-L-R samples for stereo WAV
  const buffer = new ArrayBuffer(left.length * 4); // 2 bytes * 2 channels per sample
  const view = new DataView(buffer);

  for (let i = 0; i < left.length; i++) {
    let l = Math.max(-1, Math.min(1, left[i]));
    let r = Math.max(-1, Math.min(1, right[i]));
    // Use Math.round() to properly convert float to int16 (prevents truncation artifacts)
    l = Math.round(l < 0 ? l * 0x8000 : l * 0x7FFF);
    r = Math.round(r < 0 ? r * 0x8000 : r * 0x7FFF);
    view.setInt16(i * 4, l, true);     // Left sample
    view.setInt16(i * 4 + 2, r, true); // Right sample
  }

  return buffer;
}

function floatTo24BitPCMStereo(left, right) {
  // Interleave L-R-L-R samples for stereo WAV
  // 3 bytes per sample × 2 channels = 6 bytes per sample pair
  const buffer = new ArrayBuffer(left.length * 6);
  const view = new DataView(buffer);

  for (let i = 0; i < left.length; i++) {
    let l = Math.max(-1, Math.min(1, left[i]));
    let r = Math.max(-1, Math.min(1, right[i]));

    // Scale to 24-bit range (-8388608 to 8388607)
    l = Math.round(l < 0 ? l * 0x800000 : l * 0x7FFFFF);
    r = Math.round(r < 0 ? r * 0x800000 : r * 0x7FFFFF);

    // Write 24-bit little-endian (3 bytes each)
    const offset = i * 6;
    view.setUint8(offset, l & 0xFF);
    view.setUint8(offset + 1, (l >> 8) & 0xFF);
    view.setUint8(offset + 2, (l >> 16) & 0xFF);
    view.setUint8(offset + 3, r & 0xFF);
    view.setUint8(offset + 4, (r >> 8) & 0xFF);
    view.setUint8(offset + 5, (r >> 16) & 0xFF);
  }

  return buffer;
}

function createWavFile(leftSamples, rightSamples, sampleRate, bitDepth = 16) {
  const numChannels = 2;
  const bitsPerSample = bitDepth;
  const pcmData = bitDepth === 24
    ? floatTo24BitPCMStereo(leftSamples, rightSamples)
    : floatTo16BitPCMStereo(leftSamples, rightSamples);
  const wavBuffer = new ArrayBuffer(44 + pcmData.byteLength);
  const view = new DataView(wavBuffer);

  // WAV header
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmData.byteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format (PCM)
  view.setUint16(22, numChannels, true); // num channels (stereo)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); // byte rate
  view.setUint16(32, numChannels * (bitsPerSample / 8), true); // block align
  view.setUint16(34, bitsPerSample, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, pcmData.byteLength, true);

  // Copy PCM data
  const wavBytes = new Uint8Array(wavBuffer);
  wavBytes.set(new Uint8Array(pcmData), 44);

  return wavBytes;
}

function sanitizeFilename(name, maxLength = 14) {
  // OP-XY allowed characters: a-z A-Z 0-9 space # - ( )
  // We'll use lowercase and replace spaces with hyphens for cleaner filenames
  return name
    .replace(/[^a-zA-Z0-9\s#\-()]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength) || 'sample';
}

function getMaxDurationForNote(midiNote) {
  // Pitch-aware max duration: low notes get longer, high notes shorter
  // MIDI 21 (A0) = 10s, MIDI 108 (C8) = 3s
  const minDuration = 3;   // seconds for highest notes
  const maxDuration = 10;  // seconds for lowest notes
  const minMidi = 21;      // A0
  const maxMidi = 108;     // C8

  // Clamp MIDI to valid range, default to C4 (60) if unknown
  const clampedMidi = Math.max(minMidi, Math.min(maxMidi, midiNote || 60));
  const t = (clampedMidi - minMidi) / (maxMidi - minMidi);
  return maxDuration - t * (maxDuration - minDuration);
}

// Processing Pipeline
async function processSample(file, quality, bitDepth = 16) {
  const settings = QUALITY_PRESETS[quality];
  let audioBuffer = await decodeAudioFile(file);

  // Detect root note FIRST - try filename, then audio analysis
  // We need this before truncation for pitch-aware duration
  let rootNote = parseNoteFromFilename(file.name);
  let detectionMethod = rootNote !== null ? 'filename' : null;

  if (rootNote === null) {
    const pitchResult = detectPitchFromAudio(audioBuffer);
    if (pitchResult) {
      rootNote = pitchResult.midiNote;
      detectionMethod = 'audio';
    }
  }

  // High-quality resample using Web Audio API (band-limited interpolation with anti-aliasing)
  // This must happen before extracting Float32Arrays
  audioBuffer = await resampleWithWebAudio(audioBuffer, settings.sampleRate);

  // Get stereo audio (duplicate mono to both channels if needed)
  let left, right;
  if (audioBuffer.numberOfChannels === 1) {
    // Mono input: use same data for both channels
    left = audioBuffer.getChannelData(0);
    right = audioBuffer.getChannelData(0);
  } else {
    // Stereo input: keep both channels
    left = audioBuffer.getChannelData(0);
    right = audioBuffer.getChannelData(1);
  }

  // Trim silence (uses combined amplitude for detection, same trim for both)
  ({ left, right } = trimSilenceStereo(left, right, settings.sampleRate));

  // Normalize (find max across both channels, apply same gain)
  // Target -3.5dB (~75% amplitude) to avoid being too loud on OP-XY
  ({ left, right } = normalizeStereo(left, right, -3.5));

  // Apply transparent limiter to prevent any clipping
  ({ left, right } = await applyLimiter(left, right, settings.sampleRate));

  // Apply fades
  ({ left, right } = applyFadesStereo(left, right, settings.sampleRate));

  // Pitch-aware truncation: low notes get longer, high notes shorter
  const maxDuration = getMaxDurationForNote(rootNote);
  let wasTruncated = false;
  if (left.length > settings.sampleRate * maxDuration) {
    ({ left, right } = truncateWithFadeStereo(left, right, settings.sampleRate, maxDuration));
    wasTruncated = true;
  }

  // Create stereo WAV
  const wavData = createWavFile(left, right, settings.sampleRate, bitDepth);

  return {
    originalName: file.name,
    rootNote,
    detectionMethod,
    frameCount: left.length,
    sampleRate: settings.sampleRate,
    bitDepth,
    wavData,
    wasTruncated,
    maxDuration, // Include the pitch-aware duration used
    audioBuffer // Keep for playback in assignment screen
  };
}

function selectSamplesByDensity(samples, density) {
  const preset = DENSITY_PRESETS[density];
  const maxSamples = preset.maxSamples;
  const targetInterval = preset.interval;

  // Sort by root note
  const withNotes = samples.filter(s => s.rootNote !== null).sort((a, b) => a.rootNote - b.rootNote);
  const withoutNotes = samples.filter(s => s.rootNote === null);

  // If we have fewer samples than max, just use all
  if (withNotes.length <= maxSamples) {
    const remaining = maxSamples - withNotes.length;
    return [...withNotes, ...withoutNotes.slice(0, remaining)];
  }

  // Need to reduce - select samples based on target interval
  const minNote = withNotes[0].rootNote;
  const maxNote = withNotes[withNotes.length - 1].rootNote;
  const range = maxNote - minNote;

  if (range === 0) {
    return withNotes.slice(0, maxSamples);
  }

  // Calculate how many samples we need to cover the range at target interval
  const idealCount = Math.ceil(range / targetInterval) + 1;
  const targetCount = Math.min(idealCount, maxSamples);

  // Select samples spread across the range at roughly target interval
  const selected = [];
  const step = range / (targetCount - 1 || 1);

  for (let i = 0; i < targetCount; i++) {
    const targetNote = minNote + i * step;
    let closest = null;
    let closestDist = Infinity;

    for (const s of withNotes) {
      if (selected.includes(s)) continue;
      const dist = Math.abs(s.rootNote - targetNote);
      if (dist < closestDist) {
        closestDist = dist;
        closest = s;
      }
    }

    if (closest) {
      selected.push(closest);
    }
  }

  return selected;
}

function assignMissingNotes(samples) {
  // For samples without detected notes, assign based on position
  // Start at C3 (MIDI 48) and go up chromatically
  const withNotes = samples.filter(s => s.rootNote !== null);
  const withoutNotes = samples.filter(s => s.rootNote === null);

  if (withoutNotes.length === 0) return samples;

  // Find unused notes starting from C3
  const usedNotes = new Set(withNotes.map(s => s.rootNote));
  let nextNote = 48; // C3

  withoutNotes.forEach(s => {
    while (usedNotes.has(nextNote) && nextNote <= 127) {
      nextNote++;
    }
    s.rootNote = nextNote;
    usedNotes.add(nextNote);
    nextNote++;
  });

  return [...withNotes, ...withoutNotes];
}

async function createPreset() {
  const presetName = elements.presetName.value.trim() || 'My Preset';
  const quality = Array.from(elements.qualityInputs).find(i => i.checked).value;
  const bitDepthSetting = Array.from(elements.bitDepthInputs).find(i => i.checked)?.value || 'standard';
  const bitDepth = bitDepthSetting === 'high' ? 24 : 16;
  const density = Array.from(elements.densityInputs).find(i => i.checked)?.value || 'balanced';

  showScreen('processing');
  state.warnings = [];
  state.presetName = presetName;
  state.quality = quality;
  state.bitDepth = bitDepth;
  state.density = density;

  try {
    // If using grouping, process each group separately
    if (state.useGrouping && state.detectedPattern) {
      await createGroupedPresets(quality, bitDepth, density);
      return;
    }

    // Process all samples (non-grouped)
    const totalFiles = state.files.length;
    let processed = [];

    for (let i = 0; i < totalFiles; i++) {
      elements.processingStatus.textContent = `Processing sample ${i + 1} of ${totalFiles}...`;

      try {
        const result = await processSample(state.files[i], quality, bitDepth);
        processed.push(result);

        if (result.wasTruncated) {
          state.warnings.push(`"${state.files[i].name}" was trimmed to ${Math.round(result.maxDuration)}s`);
        }
      } catch (e) {
        console.error('Failed to process:', state.files[i].name, e);
        state.warnings.push(`Could not process "${state.files[i].name}"`);
      }
    }

    if (processed.length === 0) {
      throw new Error('No samples could be processed');
    }

    // Report detection methods
    const fromFilename = processed.filter(s => s.detectionMethod === 'filename').length;
    const fromAudio = processed.filter(s => s.detectionMethod === 'audio').length;
    const undetected = processed.filter(s => s.rootNote === null);

    if (fromAudio > 0) {
      state.warnings.push(`${fromAudio} sample${fromAudio > 1 ? 's' : ''} detected via audio analysis`);
    }

    // If there are undetected samples, show assignment screen
    if (undetected.length > 0) {
      // Store detected samples for later
      state.processedSamples = processed.filter(s => s.rootNote !== null);
      // Show assignment screen with undetected samples
      showAssignmentScreen(undetected);
      return;
    }

    // All samples detected, continue processing
    continueProcessing(processed);

  } catch (e) {
    console.error('Preset creation failed:', e);
    alert('Failed to create preset: ' + e.message);
    showScreen('upload');
  }
}

// Create multiple presets from grouped samples
async function createGroupedPresets(quality, bitDepth, density) {
  const groupKeys = Object.keys(state.detectedPattern.groups).sort();
  const basePresetName = state.presetName;
  const totalGroups = groupKeys.length;

  // Store all processed samples by group for later use
  state.groupedProcessedSamples = {};
  let totalProcessed = 0;
  const totalFiles = state.files.length;
  let allUndetected = [];

  for (let g = 0; g < totalGroups; g++) {
    const groupKey = groupKeys[g];
    const groupFiles = state.detectedPattern.groups[groupKey];

    elements.processingStatus.textContent = `Processing group ${g + 1}/${totalGroups}: ${groupKey}...`;

    let processed = [];

    for (let i = 0; i < groupFiles.length; i++) {
      totalProcessed++;
      elements.processingStatus.textContent = `Processing sample ${totalProcessed} of ${totalFiles} (${groupKey})...`;

      try {
        const result = await processSample(groupFiles[i], quality, bitDepth);
        result.groupKey = groupKey; // Tag with group for later
        processed.push(result);

        if (result.wasTruncated) {
          state.warnings.push(`"${groupFiles[i].name}" was trimmed to ${Math.round(result.maxDuration)}s`);
        }
      } catch (e) {
        console.error('Failed to process:', groupFiles[i].name, e);
        state.warnings.push(`Could not process "${groupFiles[i].name}"`);
      }
    }

    // Store processed samples for this group
    state.groupedProcessedSamples[groupKey] = processed;

    // Collect undetected samples across all groups
    const undetected = processed.filter(s => s.rootNote === null);
    allUndetected = allUndetected.concat(undetected);
  }

  // If there are undetected samples, show assignment screen
  if (allUndetected.length > 0) {
    // Collect all detected samples
    state.processedSamples = [];
    for (const groupKey of groupKeys) {
      const detected = state.groupedProcessedSamples[groupKey].filter(s => s.rootNote !== null);
      state.processedSamples = state.processedSamples.concat(detected);
    }
    // Show assignment screen with undetected samples
    showAssignmentScreen(allUndetected);
    return;
  }

  // All samples detected, continue to build presets
  await finishGroupedPresets(density);
}

// Finish building grouped presets after all notes are assigned
async function finishGroupedPresets(density) {
  const groupKeys = Object.keys(state.groupedProcessedSamples).sort();
  const basePresetName = state.presetName;

  state.groupedPresets = [];

  for (const groupKey of groupKeys) {
    let processed = state.groupedProcessedSamples[groupKey];

    if (processed.length === 0) {
      continue; // Skip empty groups
    }

    // Assign any remaining missing notes
    processed = assignMissingNotes(processed);

    // Apply sample density selection
    const densityPreset = DENSITY_PRESETS[density];
    if (processed.length > densityPreset.maxSamples) {
      processed = selectSamplesByDensity(processed, density);
    }

    // Sort by root note
    processed.sort((a, b) => a.rootNote - b.rootNote);

    // Create preset name with group suffix (e.g., "My-Preset-MF")
    const groupPresetName = `${basePresetName}-${groupKey}`;

    // Build preset data for this group
    const presetData = buildPresetData(processed, groupPresetName);
    state.groupedPresets.push(presetData);
  }

  if (state.groupedPresets.length === 0) {
    throw new Error('No presets could be created');
  }

  // Build the ZIP with all presets
  await buildGroupedZip();
}

// Build preset data structure (reusable for both single and grouped presets)
function buildPresetData(processed, presetName) {
  const sanitizedName = sanitizeFilename(presetName, 14);
  const regions = [];
  const sampleFiles = {};

  // Build regions array
  processed.forEach((sample, index) => {
    const noteName = midiToNoteName(sample.rootNote).replace('#', '#');
    const filename = `${sanitizedName}-${noteName}.wav`;

    let hikey = sample.rootNote;
    if (index < processed.length - 1) {
      hikey = processed[index + 1].rootNote - 1;
    } else {
      hikey = 127;
    }

    const crossfadeAmount = Math.floor(sample.frameCount * 0.10);

    regions.push({
      framecount: sample.frameCount,
      gain: 0,
      hikey: hikey,
      lokey: 0,
      "loop.crossfade": crossfadeAmount,
      "loop.enabled": false,
      "loop.end": sample.frameCount,
      "loop.onrelease": false,
      "loop.start": 0,
      "pitch.keycenter": sample.rootNote,
      reverse: false,
      sample: filename,
      "sample.end": sample.frameCount,
      "sample.start": 0,
      tune: 0
    });

    sampleFiles[filename] = sample.wavData;
  });

  // Complete OP-XY patch.json format
  const patch = {
    engine: {
      bendrange: 0,
      highpass: 0,
      modulation: {
        aftertouch: { amount: 30719, target: 4096 },
        modwheel: { amount: 32767, target: 10240 },
        pitchbend: { amount: 16383, target: 0 },
        velocity: { amount: 16383, target: 0 }
      },
      params: [16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384],
      playmode: "poly",
      "portamento.amount": 0,
      "portamento.type": 32767,
      transpose: 0,
      "tuning.root": 0,
      "tuning.scale": 0,
      "velocity.sensitivity": 10240,
      volume: 26214,
      width: 3072
    },
    envelope: {
      amp: {
        attack: 655,
        decay: 5898,
        release: 10485,
        sustain: 21954
      },
      filter: {
        attack: 655,
        decay: 5898,
        release: 10485,
        sustain: 21954
      }
    },
    fx: {
      active: true,
      params: [32767, 0, 9439, 0, 13107, 32767, 2948, 8847],
      type: "svf"
    },
    lfo: {
      active: false,
      params: [19024, 32255, 4048, 17408, 0, 0, 0, 0],
      type: "element"
    },
    octave: 0,
    platform: "OP-XY",
    regions: regions,
    type: "multisampler",
    version: 4
  };

  return {
    name: presetName,
    sanitizedName,
    samples: processed,
    sampleCount: processed.length,
    patch,
    sampleFiles
  };
}

// Build ZIP containing multiple preset folders
async function buildGroupedZip() {
  const processingStartTime = Date.now();
  elements.processingStatus.textContent = 'Building presets...';

  const zip = new JSZip();
  let totalSamples = 0;

  for (const preset of state.groupedPresets) {
    const folderName = `${preset.sanitizedName}.preset`;
    const presetFolder = zip.folder(folderName);

    presetFolder.file('patch.json', JSON.stringify(preset.patch));

    for (const [filename, data] of Object.entries(preset.sampleFiles)) {
      presetFolder.file(filename, data);
    }

    totalSamples += preset.sampleCount;
  }

  state.zipBlob = await zip.generateAsync({ type: 'blob' });
  state.totalSize = state.zipBlob.size;
  state.samples = { length: totalSamples }; // For display purposes

  // Show complete screen after minimum 1.5s delay
  const minLoadingTime = 1500;
  const elapsed = Date.now() - processingStartTime;
  const remainingDelay = Math.max(0, minLoadingTime - elapsed);

  setTimeout(() => {
    showComplete();
  }, remainingDelay);
}

async function continueProcessing(processed) {
  showScreen('processing');
  elements.processingStatus.textContent = 'Building preset...';
  const processingStartTime = Date.now();

  try {
    // Assign missing notes for any remaining unassigned samples
    processed = assignMissingNotes(processed);

    // Apply sample density selection
    const densityPreset = DENSITY_PRESETS[state.density];
    const originalCount = processed.length;

    if (processed.length > densityPreset.maxSamples) {
      processed = selectSamplesByDensity(processed, state.density);
      state.warnings.push(`Using ${processed.length} of ${originalCount} samples (${state.density} density: ${densityPreset.description})`);
    }

    // Sort by root note
    processed.sort((a, b) => a.rootNote - b.rootNote);

    // Generate filenames and patch.json with CORRECT OP-XY format
    const sanitizedName = sanitizeFilename(state.presetName, 14);
    const regions = [];
    const sampleFiles = {};

    // Build regions array - lokey is always 0 per working preset example
    processed.forEach((sample, index) => {
      const noteName = midiToNoteName(sample.rootNote).replace('#', '#');
      // Create filename similar to working preset format
      const filename = `${sanitizedName}-${noteName}.wav`;

      // hikey defines the upper bound for this sample
      // For the highest sample, use its root note
      // For others, use the note just below the next sample
      let hikey = sample.rootNote;
      if (index < processed.length - 1) {
        hikey = processed[index + 1].rootNote - 1;
      } else {
        // Highest sample covers up to 127
        hikey = 127;
      }

      // Region format matching working OP-XY preset
      // loop.crossfade set to 10% of sample length for clean endings
      const crossfadeAmount = Math.floor(sample.frameCount * 0.10);

      regions.push({
        framecount: sample.frameCount,
        gain: 0,
        hikey: hikey,
        lokey: 0,
        "loop.crossfade": crossfadeAmount,
        "loop.enabled": false,
        "loop.end": sample.frameCount,
        "loop.onrelease": false,
        "loop.start": 0,
        "pitch.keycenter": sample.rootNote,
        reverse: false,
        sample: filename,
        "sample.end": sample.frameCount,
        "sample.start": 0,
        tune: 0
      });

      sampleFiles[filename] = sample.wavData;
    });

    // Complete OP-XY patch.json format matching working preset structure
    const patch = {
      engine: {
        bendrange: 0,
        highpass: 0,
        modulation: {
          aftertouch: { amount: 30719, target: 4096 },
          modwheel: { amount: 32767, target: 10240 },
          pitchbend: { amount: 16383, target: 0 },
          velocity: { amount: 16383, target: 0 }
        },
        params: [16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384],
        playmode: "poly",
        "portamento.amount": 0,
        "portamento.type": 32767,
        transpose: 0,
        "tuning.root": 0,
        "tuning.scale": 0,
        "velocity.sensitivity": 10240,
        volume: 26214,
        width: 3072
      },
      envelope: {
        amp: {
          attack: 655,
          decay: 5898,
          release: 10485,
          sustain: 21954
        },
        filter: {
          attack: 655,
          decay: 5898,
          release: 10485,
          sustain: 21954
        }
      },
      fx: {
        active: true,
        params: [32767, 0, 9439, 0, 13107, 32767, 2948, 8847],
        type: "svf"
      },
      lfo: {
        active: false,
        params: [19024, 32255, 4048, 17408, 0, 0, 0, 0],
        type: "element"
      },
      octave: 0,
      platform: "OP-XY",
      regions: regions,
      type: "multisampler",
      version: 4
    };

    // Create ZIP
    const zip = new JSZip();
    const presetFolder = zip.folder(`${sanitizedName}.preset`);

    presetFolder.file('patch.json', JSON.stringify(patch));

    for (const [filename, data] of Object.entries(sampleFiles)) {
      presetFolder.file(filename, data);
    }

    state.zipBlob = await zip.generateAsync({ type: 'blob' });
    state.totalSize = state.zipBlob.size;
    state.samples = processed;

    // Show complete screen after minimum 1.5s delay for the loading animation
    const minLoadingTime = 1500;
    const elapsed = Date.now() - processingStartTime;
    const remainingDelay = Math.max(0, minLoadingTime - elapsed);

    setTimeout(() => {
      showComplete();
    }, remainingDelay);

  } catch (e) {
    console.error('Preset creation failed:', e);
    alert('Failed to create preset: ' + e.message);
    showScreen('upload');
  }
}

function showComplete() {
  const sizeStr = state.totalSize < 1024 * 1024
    ? `${(state.totalSize / 1024).toFixed(1)} KB`
    : `${(state.totalSize / (1024 * 1024)).toFixed(1)} MB`;

  const bitDepthStr = state.bitDepth === 24 ? '24-bit' : '16-bit';
  const instructionsOl = document.querySelector('.instructions ol');

  // Check if we created multiple presets
  if (state.useGrouping && state.groupedPresets.length > 1) {
    const presetCount = state.groupedPresets.length;
    const totalSamples = state.groupedPresets.reduce((sum, p) => sum + p.sampleCount, 0);

    elements.completeTitle.textContent = `${presetCount} presets are ready`;
    elements.presetInfo.textContent = `${presetCount} presets • ${totalSamples} samples • ${bitDepthStr} • ${sizeStr}`;

    // Update instructions for multiple presets
    instructionsOl.innerHTML = `
      <li>Unzip the download</li>
      <li>Connect OP-XY in disk mode</li>
      <li>Copy all <code>.preset</code> folders to <code>presets/</code></li>
      <li>Eject disk and the presets will appear</li>
    `;
  } else {
    elements.completeTitle.textContent = `"${state.presetName}" is ready`;
    elements.presetInfo.textContent = `${state.samples.length} sample${state.samples.length !== 1 ? 's' : ''} • ${bitDepthStr} • ${sizeStr}`;

    // Default instructions for single preset
    instructionsOl.innerHTML = `
      <li>Unzip the download</li>
      <li>Connect OP-XY in disk mode</li>
      <li>Copy the <code>.preset</code> folder to <code>presets/</code></li>
      <li>Eject disk and the preset will appear</li>
    `;
  }

  // Add fade-in class before showing
  screens.complete.classList.add('fade-in');
  showScreen('complete');

  // Trigger the fade-in animation
  requestAnimationFrame(() => {
    screens.complete.classList.add('visible');
  });
}

function downloadPreset() {
  if (state.zipBlob) {
    const sanitizedName = sanitizeFilename(state.presetName);
    // If grouped presets, use "presets" in filename
    if (state.useGrouping && state.groupedPresets.length > 1) {
      saveAs(state.zipBlob, `${sanitizedName}.presets.zip`);
    } else {
      saveAs(state.zipBlob, `${sanitizedName}.preset.zip`);
    }
  }
}

function restart() {
  state.files = [];
  state.samples = [];
  state.warnings = [];
  state.zipBlob = null;
  state.presetName = '';
  state.unassignedSamples = [];
  state.processedSamples = [];
  state.currentOctave = 4;
  // Reset grouping state
  state.detectedPattern = null;
  state.useGrouping = false;
  state.groupedPresets = [];
  state.groupedProcessedSamples = {};

  elements.fileInput.value = '';
  elements.presetName.value = '';
  // Reset to recommended defaults
  document.querySelector('input[name="quality"][value="lofi"]').checked = true;
  document.querySelector('input[name="bitdepth"][value="standard"]').checked = true;
  document.querySelector('input[name="density"][value="balanced"]').checked = true;
  elements.warnings.classList.add('hidden');
  elements.dropZone.classList.remove('has-files');

  // Reset complete screen fade-in state
  screens.complete.classList.remove('fade-in', 'visible');

  updateFileList();
  updateCreateButton();
  showScreen('upload');
  showStep(1);
}

// Event Listeners
elements.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  elements.dropZone.classList.add('drag-over');
});

elements.dropZone.addEventListener('dragleave', () => {
  elements.dropZone.classList.remove('drag-over');
});

elements.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  elements.dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

elements.fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
});

elements.clearFiles.addEventListener('click', clearFiles);
elements.createBtn.addEventListener('click', createPreset);
elements.downloadBtn.addEventListener('click', downloadPreset);
elements.restartBtn.addEventListener('click', restart);

// Step continue button event listeners
elements.step1Continue.addEventListener('click', () => advanceStep());
elements.step2Continue.addEventListener('click', () => advanceStep());
elements.step3Continue.addEventListener('click', () => advanceStep());
elements.step4Continue.addEventListener('click', () => advanceStep());

// Grouping step event listeners
elements.useGrouping.addEventListener('click', () => {
  state.useGrouping = true;
  showStep(2);
});

elements.skipGrouping.addEventListener('click', () => {
  state.useGrouping = false;
  state.detectedPattern = null;
  showStep(2);
});

// Assignment screen event listeners
elements.octaveDown.addEventListener('click', () => updateOctave(-1));
elements.octaveUp.addEventListener('click', () => updateOctave(1));
elements.finishAssignBtn.addEventListener('click', finishAssignment);

// Theme toggle
const themeToggle = document.getElementById('theme-toggle');

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light');
  }
}

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

themeToggle.addEventListener('click', toggleTheme);

// Initialize
initTheme();
showScreen('upload');
showStep(1);
