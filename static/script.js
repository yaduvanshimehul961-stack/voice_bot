const API_URL = "/chat";
const RESET_URL = "/reset";

// DOM Elements
const micButton = document.getElementById("micButton");
const micCaption = document.getElementById("micCaption");
const statusBadge = document.getElementById("statusBadge");
const statusHint = document.getElementById("statusHint");
const recordingTime = document.getElementById("recordingTime");
const conversation = document.getElementById("conversation");
const emptyState = document.getElementById("emptyState");
const orbStage = document.getElementById("orbStage");
const voiceOrb = document.getElementById("voiceOrb");
const stopSpeechBtn = document.getElementById("stopSpeechBtn");
const resetBtn = document.getElementById("resetBtn");
const telemetrySummary = document.getElementById("telemetrySummary");
const canvas = document.getElementById("visualizerCanvas");
const canvasCtx = canvas ? canvas.getContext("2d") : null;

// Telemetry HUD Elements
const hudTotal = document.getElementById("hudTotal");
const hudStt = document.getElementById("hudStt");
const hudLlm = document.getElementById("hudLlm");
const hudTts = document.getElementById("hudTts");

// State
let mediaRecorder = null;
let audioChunks = [];
let stream = null;
let audioContext = null;
let analyser = null;
let animationFrame = null;
let timer = null;
let seconds = 0;
let currentAudio = null;

let isRecording = false;
let isProcessing = false;
let isSpeaking = false;
let continuousMode = true; // Auto-listen after AI finishes speaking

// VAD Parameters (Tuned for reliable voice detection and natural pauses)
const SPEECH_THRESHOLD = 0.008;   // Sensitive enough for normal laptop/headphone mics
const SILENCE_THRESHOLD = 0.006;  // Background noise floor
const SPEECH_CONFIRM_MS = 100;    // 100ms of audio confirms speech has started
const SILENCE_DURATION_MS = 800;  // 800ms of silence finishes sentence (prevents mid-word cutoff)
const MIN_SPEECH_DURATION_MS = 300; // Ignore tiny clicks < 300ms

let speechDetected = false;
let speechStartedAt = 0;
let silenceStartedAt = null;
let activeAudioSession = 0;

function setState(state, message) {
    if (statusBadge) statusBadge.textContent = state;
    if (statusHint) statusHint.textContent = message;

    if (orbStage) {
        orbStage.className = `orb-stage ${state.toLowerCase()}`;
    }

    if (state === "SPEAKING") {
        if (stopSpeechBtn) stopSpeechBtn.style.display = "flex";
    } else {
        if (stopSpeechBtn) stopSpeechBtn.style.display = "none";
    }
}

function updateTime() {
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    if (recordingTime) recordingTime.textContent = `${minutes}:${secs}`;
}

function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => {
        seconds++;
        updateTime();
    }, 1000);
}

function stopTimer() {
    clearInterval(timer);
    timer = null;
}

function resetTimer() {
    stopTimer();
    seconds = 0;
    updateTime();
}

function updateTelemetryHUD(latency) {
    if (!latency) return;

    const total = latency.total_ms || 0;
    const stt = latency.stt_ms || 0;
    const llm = latency.llm_ms || 0;
    const tts = latency.tts_ms || 0;

    if (hudTotal) {
        hudTotal.textContent = `${total} ms`;
        hudTotal.className = total < 2000 ? "hud-val highlight fast" : "hud-val highlight";
    }
    if (hudStt) hudStt.textContent = `${stt} ms`;
    if (hudLlm) hudLlm.textContent = `${llm} ms`;
    if (hudTts) hudTts.textContent = `${tts} ms`;

    if (telemetrySummary) {
        if (total < 1000) {
            telemetrySummary.textContent = `LATENCY: ${total}ms (⚡ SUB-1S ULTRA FAST)`;
        } else if (total < 2000) {
            telemetrySummary.textContent = `LATENCY: ${total}ms (✓ UNDER 2s)`;
        } else {
            telemetrySummary.textContent = `LATENCY: ${total}ms`;
        }
    }
}

function addMessage(role, text, latency = null) {
    if (!text) return;

    if (emptyState && emptyState.parentElement) {
        emptyState.remove();
    }

    const message = document.createElement("div");
    message.className = `message ${role}`;

    const header = document.createElement("div");
    header.className = "message-header";

    const sender = document.createElement("span");
    sender.className = "message-sender";
    sender.textContent = role === "user" ? "YOU" : "NOVA AI";
    header.appendChild(sender);

    if (role === "ai" && latency && latency.total_ms) {
        const latencyBadge = document.createElement("span");
        latencyBadge.className = "message-latency";
        latencyBadge.textContent = `⚡ ${latency.total_ms}ms`;
        header.appendChild(latencyBadge);
    }

    const textDiv = document.createElement("div");
    textDiv.className = "message-text";
    textDiv.textContent = text;

    message.appendChild(header);
    message.appendChild(textDiv);
    conversation.appendChild(message);
    conversation.scrollTop = conversation.scrollHeight;
}

function getMimeType() {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        return "audio/webm;codecs=opus";
    }
    if (MediaRecorder.isTypeSupported("audio/webm")) {
        return "audio/webm";
    }
    return "";
}

function cleanupAudioAnalysis() {
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
    analyser = null;
    silenceStartedAt = null;

    if (canvasCtx && canvas) {
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function cleanupStream() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    cleanupAudioAnalysis();
}

function getRms(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        const val = (data[i] - 128) / 128;
        sum += val * val;
    }
    return Math.sqrt(sum / data.length);
}

function drawVisualizer(freqData, isSpeakingNow) {
    if (!canvasCtx || !canvas) return;

    const width = canvas.width;
    const height = canvas.height;
    canvasCtx.clearRect(0, 0, width, height);

    const bars = 28;
    const barWidth = 6;
    const gap = (width - bars * barWidth) / (bars - 1);

    for (let i = 0; i < bars; i++) {
        const index = Math.floor(i * (freqData.length / bars));
        const val = freqData[index] / 255.0;
        const barHeight = Math.max(3, val * height * 0.95);
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;

        const gradient = canvasCtx.createLinearGradient(0, y, 0, y + barHeight);
        if (isSpeakingNow) {
            gradient.addColorStop(0, "#00f2fe");
            gradient.addColorStop(1, "#7c3aed");
        } else {
            gradient.addColorStop(0, "#10b981");
            gradient.addColorStop(1, "#0284c7");
        }

        canvasCtx.fillStyle = gradient;
        canvasCtx.beginPath();
        canvasCtx.roundRect(x, y, barWidth, barHeight, 3);
        canvasCtx.fill();
    }
}

function startVoiceAnalysis() {
    if (!stream) return;

    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioCtx();
        if (audioContext.state === "suspended") {
            audioContext.resume();
        }

        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);

        const timeData = new Uint8Array(analyser.fftSize);
        const freqData = new Uint8Array(analyser.frequencyBinCount);

        function analyse() {
            if (!mediaRecorder || mediaRecorder.state !== "recording") {
                return;
            }

            analyser.getByteTimeDomainData(timeData);
            analyser.getByteFrequencyData(freqData);

            drawVisualizer(freqData, isSpeaking);

            const rms = getRms(timeData);
            const now = Date.now();

            if (!speechDetected) {
                if (rms >= SPEECH_THRESHOLD) {
                    if (!speechStartedAt) speechStartedAt = now;

                    if (now - speechStartedAt >= SPEECH_CONFIRM_MS) {
                        speechDetected = true;
                        silenceStartedAt = null;

                        // Barge-in: If Nova is talking and user speaks -> interrupt
                        if (isSpeaking) {
                            stopCurrentAudio();
                        }
                        setState("LISTENING", "Hearing you... Keep speaking");
                    }
                } else {
                    speechStartedAt = 0;
                }
            } else {
                // Speech already detected, track silence
                if (rms < SILENCE_THRESHOLD) {
                    if (!silenceStartedAt) silenceStartedAt = now;

                    if (
                        now - silenceStartedAt >= SILENCE_DURATION_MS &&
                        now - speechStartedAt >= MIN_SPEECH_DURATION_MS
                    ) {
                        // User paused for 800ms -> send audio!
                        stopRecordingAndSend();
                        return;
                    }
                } else {
                    silenceStartedAt = null;
                }
            }

            animationFrame = requestAnimationFrame(analyse);
        }

        animationFrame = requestAnimationFrame(analyse);
    } catch (err) {
        console.error("Audio analysis initialization error:", err);
    }
}

async function startRecording() {
    if (isProcessing) return;
    if (mediaRecorder && mediaRecorder.state === "recording") return;

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const mimeType = getMimeType();
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        audioChunks = [];

        speechDetected = false;
        speechStartedAt = 0;
        silenceStartedAt = null;

        seconds = 0;
        updateTime();

        mediaRecorder.ondataavailable = e => {
            if (e.data && e.data.size > 0) {
                audioChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            cleanupAudioAnalysis();
            // ALWAYS send whatever audio was captured!
            if (audioChunks.length > 0) {
                sendAudio();
            } else {
                isProcessing = false;
                setState("READY", "Click mic to speak");
                if (micButton) micButton.classList.remove("active");
                if (micCaption) micCaption.textContent = "TAP TO TALK";
            }
        };

        mediaRecorder.onerror = err => {
            console.error("MediaRecorder error:", err);
            cleanupStream();
            isProcessing = false;
            isRecording = false;
        };

        // Collect chunks every 100ms
        mediaRecorder.start(100);
        isRecording = true;
        startTimer();
        startVoiceAnalysis();

        setState("LISTENING", "Listening... Speak now or tap to send");
        if (micButton) micButton.classList.add("active");
        if (micCaption) micCaption.textContent = "TAP TO SEND";

    } catch (err) {
        console.error("Microphone access error:", err);
        cleanupStream();
        isRecording = false;
        if (micButton) micButton.classList.remove("active");
        if (micCaption) micCaption.textContent = "TAP TO TALK";
        setState("MIC ERROR", "Please allow microphone access in your browser");
    }
}

function stopRecordingAndSend() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;

    stopTimer();
    cleanupAudioAnalysis();

    isRecording = false;
    isProcessing = true;
    setState("THINKING", "Processing with Groq LPUs...");
    if (micCaption) micCaption.textContent = "PROCESSING";

    mediaRecorder.stop();

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
}

function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
}

function isStopCommand(text) {
    const value = text.toLowerCase().trim().replace(/[.!?,]/g, "");
    const commands = [
        "stop", "stop listening", "stop now", "please stop",
        "okay stop", "ok stop", "shut up", "cancel", "khatam", "ruko", "chup"
    ];
    return commands.includes(value);
}

function speakWithBrowserTTS(text) {
    return new Promise((resolve) => {
        if (!("speechSynthesis" in window)) {
            resolve();
            return;
        }

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);

        // Try to pick a natural voice
        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(v => v.lang.includes("hi") || v.name.includes("India")) ||
                               voices.find(v => v.lang.includes("en")) ||
                               voices[0];
        if (preferredVoice) utterance.voice = preferredVoice;

        utterance.rate = 1.05;
        utterance.pitch = 1.0;

        utterance.onend = () => {
            isSpeaking = false;
            resolve();
        };

        utterance.onerror = () => {
            isSpeaking = false;
            resolve();
        };

        isSpeaking = true;
        setState("SPEAKING", "Nova is speaking... (tap orb or say stop to interrupt)");
        if (micCaption) micCaption.textContent = "SPEAKING";

        window.speechSynthesis.speak(utterance);
    });
}

async function sendAudio() {
    const turnStartTime = performance.now();

    try {
        if (!audioChunks.length) {
            isProcessing = false;
            if (continuousMode) await startRecording();
            return;
        }

        const mimeType = mediaRecorder?.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        const extension = mimeType.includes("webm") ? "webm" : "wav";

        const formData = new FormData();
        formData.append("audio_file", audioBlob, `recording.${extension}`);

        const response = await fetch(API_URL, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Server Error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const clientTurnTime = Math.round(performance.now() - turnStartTime);

        const userText = data.user_text || "";
        const responseText = data.response_text || "";
        const latency = data.latency || { total_ms: clientTurnTime };

        // Update Live Telemetry HUD
        updateTelemetryHUD(latency);

        if (userText) {
            addMessage("user", userText);
        }

        if (data.stopped || isStopCommand(userText)) {
            stopCurrentAudio();
            isRecording = false;
            isProcessing = false;
            isSpeaking = false;
            if (micButton) micButton.classList.remove("active");
            if (micCaption) micCaption.textContent = "TAP TO TALK";
            setState("STOPPED", "Voice assistant stopped");
            return;
        }

        if (data.no_speech) {
            // Audio didn't have clear speech
            setState("LISTENING", "Aapki aawaz clear nahi thi. Dobara boliye...");
            isProcessing = false;
            if (continuousMode) {
                setTimeout(startRecording, 600);
            }
            return;
        }

        if (responseText) {
            addMessage("ai", responseText, latency);
        }

        // Handle Audio Response (ElevenLabs or Browser Fallback)
        if (data.audio) {
            const audioBlobResponse = base64ToBlob(data.audio, "audio/mpeg");
            const audioUrl = URL.createObjectURL(audioBlobResponse);
            const audio = new Audio(audioUrl);

            const session = ++activeAudioSession;
            currentAudio = audio;

            isProcessing = false;
            isSpeaking = true;

            setState("SPEAKING", "Nova is speaking... (tap orb or say stop to interrupt)");
            if (micCaption) micCaption.textContent = "SPEAKING";

            audio.onended = async () => {
                if (session !== activeAudioSession) return;

                URL.revokeObjectURL(audioUrl);
                currentAudio = null;
                isSpeaking = false;
                resetTimer();

                if (continuousMode) {
                    setState("LISTENING", "Listening for your reply...");
                    if (micCaption) micCaption.textContent = "LISTENING";
                    await startRecording();
                } else {
                    setState("READY", "Click mic to speak");
                    if (micButton) micButton.classList.remove("active");
                    if (micCaption) micCaption.textContent = "TAP TO TALK";
                }
            };

            audio.onerror = async () => {
                URL.revokeObjectURL(audioUrl);
                currentAudio = null;
                isSpeaking = false;
                // Fallback to browser TTS
                await speakWithBrowserTTS(responseText);
                if (continuousMode) startRecording();
            };

            await audio.play();

        } else if (responseText) {
            // No audio returned from backend (e.g. ElevenLabs quota limit) -> use Browser Web Speech!
            isProcessing = false;
            await speakWithBrowserTTS(responseText);
            if (continuousMode) {
                setState("LISTENING", "Listening for your reply...");
                await startRecording();
            } else {
                setState("READY", "Click mic to speak");
            }
        } else {
            isProcessing = false;
            if (continuousMode) await startRecording();
        }

    } catch (err) {
        console.error("sendAudio error:", err);
        isProcessing = false;
        isSpeaking = false;
        isRecording = false;
        cleanupStream();
        setState("ERROR", err.message || "An error occurred");

        if (continuousMode) {
            setTimeout(() => {
                startRecording();
            }, 1200);
        }
    }
}

function stopCurrentAudio() {
    activeAudioSession++;
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
    isSpeaking = false;
}

// User Interactions
if (micButton) {
    micButton.addEventListener("click", async () => {
        if (isSpeaking) {
            stopCurrentAudio();
            await startRecording();
            return;
        }

        if (isRecording) {
            // TAP TO SEND: User clicked while recording -> immediately send audio!
            stopRecordingAndSend();
        } else {
            // TAP TO TALK: Start recording
            await startRecording();
        }
    });
}

if (voiceOrb) {
    voiceOrb.addEventListener("click", async () => {
        if (isSpeaking) {
            stopCurrentAudio();
            if (continuousMode) await startRecording();
        } else if (!isRecording && !isProcessing) {
            await startRecording();
        } else if (isRecording) {
            stopRecordingAndSend();
        }
    });
}

if (stopSpeechBtn) {
    stopSpeechBtn.addEventListener("click", () => {
        stopCurrentAudio();
        setState("READY", "Audio stopped. Click mic to speak.");
        if (micButton) micButton.classList.remove("active");
        if (micCaption) micCaption.textContent = "TAP TO TALK";
    });
}

if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
        try {
            await fetch(RESET_URL, { method: "POST" });
            stopCurrentAudio();
            if (conversation) {
                conversation.innerHTML = `
                    <div class="empty-state" id="emptyState">
                        <div class="empty-glow">✦</div>
                        <h4>Conversation Reset</h4>
                        <p>Speak naturally in Hindi or English. Nova will answer in under 1 second.</p>
                    </div>
                `;
            }
            if (hudTotal) hudTotal.textContent = "-- ms";
            if (hudStt) hudStt.textContent = "-- ms";
            if (hudLlm) hudLlm.textContent = "-- ms";
            if (hudTts) hudTts.textContent = "-- ms";
            if (telemetrySummary) telemetrySummary.textContent = "LATENCY: READY (<1s)";
            setState("READY", "Conversation reset. Click mic to start.");
        } catch (e) {
            console.error("Reset error:", e);
        }
    });
}

// Pre-load browser voices
if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}

// Initialize
setState("READY", "Click the microphone to talk");
updateTime();