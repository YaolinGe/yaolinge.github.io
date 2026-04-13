"use strict";

const MODES = {
    emom: {
        id: "emom",
        label: "EMOM",
        description: "Every interval + Rest interval, repeated for a chosen number of rounds.",
        fields: [
            {
                id: "everyInterval",
                type: "duration",
                label: "Every Interval",
                defaultMinutes: 1,
                defaultSeconds: 0,
                minSeconds: 1,
                hint: "Any duration is valid (for example 00:20, 01:00, 02:00)."
            },
            {
                id: "restInterval",
                type: "duration",
                label: "Rest Duration",
                defaultMinutes: 0,
                defaultSeconds: 30,
                minSeconds: 0,
                hint: "Set 00:00 for no rest."
            },
            {
                id: "rounds",
                type: "number",
                label: "Rounds",
                min: 1,
                max: 100,
                step: 1,
                defaultValue: 10
            }
        ],
        createSession(values) {
            const cycleSeconds = values.everyInterval + values.restInterval;

            return {
                modeId: "emom",
                clockType: "countdown",
                totalSeconds: cycleSeconds * values.rounds,
                hasRounds: true,
                emom: {
                    everySeconds: values.everyInterval,
                    restSeconds: values.restInterval,
                    rounds: values.rounds,
                    cycleSeconds
                }
            };
        }
    },
    amrap: {
        id: "amrap",
        label: "AMRAP",
        description: "As many rounds/reps as possible in a fixed time cap.",
        fields: [
            {
                id: "timeCap",
                type: "duration",
                label: "Time Cap",
                defaultMinutes: 12,
                defaultSeconds: 0,
                minSeconds: 1
            }
        ],
        createSession(values) {
            return {
                modeId: "amrap",
                clockType: "countdown",
                totalSeconds: values.timeCap,
                hasRounds: false
            };
        }
    },
    tc: {
        id: "tc",
        label: "TC",
        description: "Simple time-cap countdown timer.",
        fields: [
            {
                id: "timeCap",
                type: "duration",
                label: "Time Cap",
                defaultMinutes: 20,
                defaultSeconds: 0,
                minSeconds: 1
            }
        ],
        createSession(values) {
            return {
                modeId: "tc",
                clockType: "countdown",
                totalSeconds: values.timeCap,
                hasRounds: false
            };
        }
    },
    ft: {
        id: "ft",
        label: "FT",
        description: "For Time. Count up until you finish. Optional cap can auto-stop the timer.",
        fields: [
            {
                id: "timeCap",
                type: "duration",
                label: "Optional Time Cap",
                defaultMinutes: 0,
                defaultSeconds: 0,
                minSeconds: 0,
                hint: "Set 00:00 for no cap."
            }
        ],
        createSession(values) {
            return {
                modeId: "ft",
                clockType: "countup",
                timeCapSeconds: values.timeCap,
                hasRounds: false
            };
        }
    }
};

function toInt(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function formatClock(totalSeconds) {
    const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const seconds = wholeSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

class AudioCuePlayer {
    constructor() {
        this.enabled = true;
        this.AudioContextClass = window.AudioContext || window.webkitAudioContext || null;
        this.audioContext = null;
        this.speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
        this.voice = null;

        this.loadPreferredVoice = this.loadPreferredVoice.bind(this);

        if (this.speechSupported) {
            window.speechSynthesis.addEventListener("voiceschanged", this.loadPreferredVoice);
            this.loadPreferredVoice();
        }
    }

    setEnabled(isEnabled) {
        this.enabled = Boolean(isEnabled);
        if (!this.enabled) {
            this.stopSpeech();
        }
    }

    ensureContext() {
        if (!this.enabled) {
            return null;
        }

        if (!this.AudioContextClass) {
            return null;
        }

        if (!this.audioContext) {
            this.audioContext = new this.AudioContextClass();
        }

        if (this.audioContext.state === "suspended") {
            this.audioContext.resume().catch(() => {});
        }

        return this.audioContext;
    }

    prime() {
        this.ensureContext();
        this.loadPreferredVoice();
    }

    loadPreferredVoice() {
        if (!this.speechSupported) {
            return;
        }

        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) {
            return;
        }

        const matches = [
            (voice) => voice.lang && voice.lang.toLowerCase().startsWith("en-us"),
            (voice) => voice.lang && voice.lang.toLowerCase().startsWith("en"),
            () => true
        ];

        for (const matcher of matches) {
            const picked = voices.find(matcher);
            if (picked) {
                this.voice = picked;
                break;
            }
        }
    }

    speak(text, { rate = 1, pitch = 1, volume = 1, interrupt = false } = {}) {
        if (!this.enabled || !this.speechSupported || !text) {
            return;
        }

        const synth = window.speechSynthesis;
        if (interrupt) {
            synth.cancel();
        }

        const utterance = new window.SpeechSynthesisUtterance(text);
        if (this.voice) {
            utterance.voice = this.voice;
            utterance.lang = this.voice.lang;
        } else {
            utterance.lang = "en-US";
        }
        utterance.rate = rate;
        utterance.pitch = pitch;
        utterance.volume = volume;
        synth.speak(utterance);
    }

    stopSpeech() {
        if (this.speechSupported) {
            window.speechSynthesis.cancel();
        }
    }

    playPattern(steps) {
        const ctx = this.ensureContext();
        if (!ctx) {
            return;
        }

        let cursor = ctx.currentTime + 0.01;
        for (const step of steps) {
            const oscillator = ctx.createOscillator();
            const volume = ctx.createGain();
            const duration = step.duration ?? 0.08;
            const gain = step.gain ?? 0.055;
            const attack = Math.min(0.01, duration / 4);

            oscillator.type = step.type || "triangle";
            oscillator.frequency.setValueAtTime(step.frequency, cursor);
            volume.gain.setValueAtTime(0.0001, cursor);
            volume.gain.exponentialRampToValueAtTime(gain, cursor + attack);
            volume.gain.exponentialRampToValueAtTime(0.0001, cursor + duration);

            oscillator.connect(volume);
            volume.connect(ctx.destination);
            oscillator.start(cursor);
            oscillator.stop(cursor + duration);

            cursor += duration + (step.gap ?? 0.04);
        }
    }

    playStartCue() {
        this.playPattern([
            { frequency: 760, duration: 0.08 },
            { frequency: 920, duration: 0.1, gap: 0.06 }
        ]);
    }

    playIntervalCue() {
        this.playPattern([
            { frequency: 620, duration: 0.07, gain: 0.045 },
            { frequency: 720, duration: 0.08, gain: 0.05 }
        ]);
    }

    playHalfwayCue() {
        this.playPattern([
            { frequency: 700, duration: 0.07, gain: 0.045 },
            { frequency: 840, duration: 0.09, gain: 0.05 }
        ]);
        this.speak("Halfway there.", { rate: 1.03, pitch: 1, volume: 1 });
    }

    playCountdownCue(step) {
        const countdownFrequencies = {
            3: 760,
            2: 830,
            1: 910
        };

        if (step === 0) {
            this.playPattern([
                { frequency: 1020, duration: 0.1, gain: 0.06 },
                { frequency: 1180, duration: 0.14, gain: 0.065 }
            ]);
            this.speak("Ready to go.", { rate: 1.08, pitch: 1, volume: 1, interrupt: true });
            return;
        }

        const frequency = countdownFrequencies[step] || 760;
        this.playPattern([{ frequency, duration: 0.08, gain: 0.058 }]);
    }

    playFinishCue() {
        this.playPattern([
            { frequency: 740, duration: 0.08, gain: 0.055 },
            { frequency: 880, duration: 0.1, gain: 0.06 },
            { frequency: 1046, duration: 0.14, gain: 0.065 }
        ]);
        this.speak("Workout complete.", { rate: 0.98, pitch: 1, volume: 1, interrupt: true });
    }
}

class TimerEngine {
    constructor({ onTick, onComplete }) {
        this.onTick = onTick;
        this.onComplete = onComplete;
        this.session = null;
        this.state = "idle";
        this.startedAt = 0;
        this.elapsedBeforePauseMs = 0;
        this.rafId = null;
        this.tick = this.tick.bind(this);
    }

    configure(session) {
        this.stopFrame();
        this.session = session;
        this.state = "idle";
        this.startedAt = 0;
        this.elapsedBeforePauseMs = 0;
        this.emitTick();
    }

    start() {
        if (!this.session || this.state === "running" || this.state === "completed") {
            return;
        }

        this.startedAt = performance.now();
        this.state = "running";
        this.tick();
    }

    pause() {
        if (this.state !== "running") {
            return;
        }

        this.elapsedBeforePauseMs += performance.now() - this.startedAt;
        this.state = "paused";
        this.stopFrame();
        this.emitTick();
    }

    reset() {
        this.stopFrame();
        this.state = "idle";
        this.startedAt = 0;
        this.elapsedBeforePauseMs = 0;
        this.emitTick();
    }

    stopFrame() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    tick() {
        if (this.state !== "running") {
            return;
        }

        const snapshot = this.buildSnapshot(performance.now());
        this.onTick(snapshot);

        if (snapshot.shouldComplete) {
            this.finish();
            return;
        }

        this.rafId = requestAnimationFrame(this.tick);
    }

    finish() {
        this.stopFrame();
        this.state = "completed";

        if (this.session.clockType === "countdown") {
            this.elapsedBeforePauseMs = this.session.totalSeconds * 1000;
        } else if (this.session.timeCapSeconds > 0) {
            this.elapsedBeforePauseMs = this.session.timeCapSeconds * 1000;
        }

        const completedSnapshot = this.buildSnapshot(performance.now());
        this.onTick(completedSnapshot);
        this.onComplete(completedSnapshot);
    }

    emitTick() {
        this.onTick(this.buildSnapshot(performance.now()));
    }

    buildSnapshot(nowMs) {
        const runningOffset = this.state === "running" ? nowMs - this.startedAt : 0;
        const elapsedMs = this.elapsedBeforePauseMs + runningOffset;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);

        if (!this.session) {
            return {
                state: this.state,
                displaySeconds: 0,
                elapsedSeconds: 0,
                remainingSeconds: null,
                hasRemaining: false,
                shouldComplete: false
            };
        }

        if (this.session.clockType === "countdown") {
            const remainingSeconds = Math.max(this.session.totalSeconds - elapsedSeconds, 0);
            return {
                state: this.state,
                displaySeconds: remainingSeconds,
                elapsedSeconds: Math.min(elapsedSeconds, this.session.totalSeconds),
                remainingSeconds,
                hasRemaining: true,
                shouldComplete: this.state === "running" && elapsedSeconds >= this.session.totalSeconds
            };
        }

        const hasCap = this.session.timeCapSeconds > 0;
        const remainingSeconds = hasCap ? Math.max(this.session.timeCapSeconds - elapsedSeconds, 0) : null;
        const limitedElapsed = hasCap ? Math.min(elapsedSeconds, this.session.timeCapSeconds) : elapsedSeconds;

        return {
            state: this.state,
            displaySeconds: limitedElapsed,
            elapsedSeconds: limitedElapsed,
            remainingSeconds,
            hasRemaining: hasCap,
            shouldComplete: hasCap && this.state === "running" && elapsedSeconds >= this.session.timeCapSeconds
        };
    }
}

class SmartWodClockApp {
    constructor() {
        this.modeSelect = document.getElementById("modeSelect");
        this.modeDescription = document.getElementById("modeDescription");
        this.modeFields = document.getElementById("modeFields");
        this.errorMessage = document.getElementById("errorMessage");

        this.startBtn = document.getElementById("startBtn");
        this.pauseBtn = document.getElementById("pauseBtn");
        this.resetBtn = document.getElementById("resetBtn");
        this.soundToggle = document.getElementById("soundToggle");

        this.statusBadge = document.getElementById("statusBadge");
        this.timerDisplay = document.getElementById("timerDisplay");
        this.roundValue = document.getElementById("roundValue");
        this.phaseValue = document.getElementById("phaseValue");
        this.elapsedValue = document.getElementById("elapsedValue");
        this.remainingValue = document.getElementById("remainingValue");

        this.audio = new AudioCuePlayer();
        this.timer = new TimerEngine({
            onTick: (snapshot) => this.renderTimer(snapshot),
            onComplete: () => this.handleCompletion()
        });

        this.session = null;
        this.halfwayCuePlayed = false;
        this.emomCueState = this.createDefaultEmomCueState();
    }

    init() {
        this.populateModes();
        this.bindEvents();
        this.renderFields();
        this.setStatus("idle");
        this.syncButtons();
    }

    createDefaultEmomCueState() {
        return {
            phaseKey: null,
            phaseType: null,
            halfCueKey: null,
            lastCountdownStep: null
        };
    }

    populateModes() {
        const options = Object.values(MODES)
            .map((mode) => `<option value="${mode.id}">${mode.label}</option>`)
            .join("");
        this.modeSelect.innerHTML = options;
    }

    bindEvents() {
        this.modeSelect.addEventListener("change", () => {
            this.handleReset({ clearSession: true });
            this.renderFields();
        });

        this.startBtn.addEventListener("click", () => this.handleStart());
        this.pauseBtn.addEventListener("click", () => this.handlePauseResume());
        this.resetBtn.addEventListener("click", () => this.handleReset({ clearSession: true }));
        this.soundToggle.addEventListener("change", (event) => {
            this.audio.setEnabled(event.target.checked);
        });
    }

    get currentMode() {
        return MODES[this.modeSelect.value];
    }

    renderFields() {
        const { description, fields } = this.currentMode;
        this.modeDescription.textContent = description;
        this.modeFields.innerHTML = fields.map((field) => this.renderField(field)).join("");
    }

    renderField(field) {
        if (field.type === "number") {
            return `
                <div class="field">
                    <label for="${field.id}">${field.label}</label>
                    <input id="${field.id}" type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${field.defaultValue}">
                    ${field.hint ? `<p class="field-hint">${field.hint}</p>` : ""}
                </div>
            `;
        }

        return `
            <div class="field">
                <label>${field.label}</label>
                <div class="duration-row">
                    <input id="${field.id}Minutes" type="number" min="0" max="240" step="1" value="${field.defaultMinutes}" aria-label="${field.label} minutes">
                    <input id="${field.id}Seconds" type="number" min="0" max="59" step="1" value="${field.defaultSeconds}" aria-label="${field.label} seconds">
                </div>
                ${field.hint ? `<p class="field-hint">${field.hint}</p>` : ""}
            </div>
        `;
    }

    readValues() {
        const values = {};

        for (const field of this.currentMode.fields) {
            if (field.type === "number") {
                const input = document.getElementById(field.id);
                const value = toInt(input.value);

                if (value < field.min || value > field.max) {
                    throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
                }

                values[field.id] = value;
                continue;
            }

            const minutesInput = document.getElementById(`${field.id}Minutes`);
            const secondsInput = document.getElementById(`${field.id}Seconds`);
            const minutes = clamp(toInt(minutesInput.value), 0, 240);
            const seconds = clamp(toInt(secondsInput.value), 0, 59);
            const totalSeconds = minutes * 60 + seconds;

            if (totalSeconds < field.minSeconds) {
                throw new Error(`${field.label} must be greater than 00:00.`);
            }

            values[field.id] = totalSeconds;
        }

        return values;
    }

    handleStart() {
        this.clearError();
        this.audio.prime();

        if (this.timer.state === "paused") {
            this.timer.start();
            this.setStatus("running");
            this.syncButtons();
            return;
        }

        try {
            const values = this.readValues();
            this.session = this.currentMode.createSession(values);
        } catch (error) {
            this.setError(error.message);
            return;
        }

        this.halfwayCuePlayed = false;
        this.emomCueState = this.createDefaultEmomCueState();

        this.timer.configure(this.session);
        this.timer.start();
        this.audio.playStartCue();
        this.setStatus("running");
        this.syncButtons();
    }

    handlePauseResume() {
        if (this.timer.state === "running") {
            this.timer.pause();
            this.setStatus("paused");
            this.syncButtons();
            return;
        }

        if (this.timer.state === "paused") {
            this.timer.start();
            this.setStatus("running");
            this.syncButtons();
        }
    }

    handleReset({ clearSession }) {
        this.timer.reset();
        this.audio.stopSpeech();
        this.clearError();

        if (clearSession) {
            this.session = null;
        }

        this.halfwayCuePlayed = false;
        this.emomCueState = this.createDefaultEmomCueState();
        this.roundValue.textContent = "-";
        this.phaseValue.textContent = "-";
        this.elapsedValue.textContent = "00:00";
        this.remainingValue.textContent = "--:--";
        this.timerDisplay.textContent = "00:00";
        this.setStatus("idle");
        this.syncButtons();
    }

    handleCompletion() {
        this.setStatus("completed");
        this.audio.playFinishCue();
        this.syncButtons();
    }

    renderTimer(snapshot) {
        if (this.session && this.session.modeId === "emom") {
            this.renderEmomTimer(snapshot);
        } else {
            this.renderStandardTimer(snapshot);
        }
    }

    renderStandardTimer(snapshot) {
        this.timerDisplay.textContent = formatClock(snapshot.displaySeconds);
        this.elapsedValue.textContent = formatClock(snapshot.elapsedSeconds);
        this.remainingValue.textContent = snapshot.hasRemaining && snapshot.remainingSeconds !== null
            ? formatClock(snapshot.remainingSeconds)
            : "--:--";
        this.roundValue.textContent = "-";
        this.phaseValue.textContent = "-";

        if (snapshot.state !== "running" || !this.session || this.halfwayCuePlayed) {
            return;
        }

        const totalSeconds = this.session.clockType === "countdown"
            ? this.session.totalSeconds
            : this.session.timeCapSeconds;

        if (!totalSeconds || totalSeconds <= 1) {
            return;
        }

        if (snapshot.elapsedSeconds >= Math.ceil(totalSeconds / 2)) {
            this.audio.playHalfwayCue();
            this.halfwayCuePlayed = true;
        }
    }

    renderEmomTimer(snapshot) {
        const progress = this.getEmomProgress(snapshot.elapsedSeconds);

        this.timerDisplay.textContent = formatClock(progress.phaseRemainingSeconds);
        this.elapsedValue.textContent = formatClock(snapshot.elapsedSeconds);
        this.remainingValue.textContent = snapshot.remainingSeconds !== null
            ? formatClock(snapshot.remainingSeconds)
            : "--:--";
        this.roundValue.textContent = String(progress.round);
        this.phaseValue.textContent = progress.phaseLabel;

        if (snapshot.state === "running") {
            this.processEmomCues(progress);
        }
    }

    getEmomProgress(elapsedSeconds) {
        const config = this.session.emom;
        const totalSeconds = config.cycleSeconds * config.rounds;
        const boundedElapsed = Math.min(elapsedSeconds, totalSeconds);

        if (boundedElapsed >= totalSeconds) {
            return {
                round: config.rounds,
                phase: "done",
                phaseLabel: "Done",
                phaseDurationSeconds: 0,
                phaseElapsedSeconds: 0,
                phaseRemainingSeconds: 0,
                phaseKey: `${config.rounds}:done`,
                isRestPhase: false
            };
        }

        const zeroBasedRound = Math.floor(boundedElapsed / config.cycleSeconds);
        const round = zeroBasedRound + 1;
        const elapsedInRound = boundedElapsed - zeroBasedRound * config.cycleSeconds;

        if (config.restSeconds > 0 && elapsedInRound >= config.everySeconds) {
            const phaseElapsedSeconds = elapsedInRound - config.everySeconds;
            return {
                round,
                phase: "rest",
                phaseLabel: "Rest",
                phaseDurationSeconds: config.restSeconds,
                phaseElapsedSeconds,
                phaseRemainingSeconds: Math.max(config.restSeconds - phaseElapsedSeconds, 0),
                phaseKey: `${round}:rest`,
                isRestPhase: true
            };
        }

        return {
            round,
            phase: "every",
            phaseLabel: "Every",
            phaseDurationSeconds: config.everySeconds,
            phaseElapsedSeconds: elapsedInRound,
            phaseRemainingSeconds: Math.max(config.everySeconds - elapsedInRound, 0),
            phaseKey: `${round}:every`,
            isRestPhase: false
        };
    }

    processEmomCues(progress) {
        const previousPhase = this.emomCueState.phaseType;

        if (progress.phaseKey !== this.emomCueState.phaseKey) {
            if (previousPhase === "rest" && progress.phase === "every") {
                this.audio.playCountdownCue(0);
            } else if (previousPhase === "every" && progress.phase === "rest") {
                this.audio.playIntervalCue();
            }

            this.emomCueState.phaseKey = progress.phaseKey;
            this.emomCueState.phaseType = progress.phase;
            this.emomCueState.lastCountdownStep = null;
        }

        if (
            progress.phase === "every" &&
            progress.phaseDurationSeconds > 2 &&
            progress.phaseElapsedSeconds >= Math.ceil(progress.phaseDurationSeconds / 2)
        ) {
            const halfCueKey = `${progress.phaseKey}:half`;
            if (this.emomCueState.halfCueKey !== halfCueKey) {
                this.audio.playHalfwayCue();
                this.emomCueState.halfCueKey = halfCueKey;
            }
        }

        if (progress.isRestPhase && progress.phaseRemainingSeconds <= 3) {
            const countdownStep = progress.phaseRemainingSeconds;
            if (countdownStep !== this.emomCueState.lastCountdownStep) {
                this.audio.playCountdownCue(countdownStep);
                this.emomCueState.lastCountdownStep = countdownStep;
            }
        }
    }

    setStatus(state) {
        const labels = {
            idle: "Ready",
            running: "Running",
            paused: "Paused",
            completed: "Done"
        };

        this.statusBadge.textContent = labels[state] || "Ready";
        this.statusBadge.className = "status-badge";

        if (state === "running") {
            this.statusBadge.classList.add("status-running");
        } else if (state === "paused") {
            this.statusBadge.classList.add("status-paused");
        } else if (state === "completed") {
            this.statusBadge.classList.add("status-completed");
        }
    }

    syncButtons() {
        const state = this.timer.state;
        this.startBtn.disabled = state === "running";
        this.pauseBtn.disabled = state !== "running" && state !== "paused";
        this.pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
    }

    setError(message) {
        this.errorMessage.textContent = message;
    }

    clearError() {
        this.errorMessage.textContent = "";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const app = new SmartWodClockApp();
    app.init();
});
