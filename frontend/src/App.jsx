import { useEffect, useRef, useState } from "react";
import "./App.css";

const API = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
function logLatency(operation, startedAt) {
  const durationMs = performance.now() - startedAt;
  console.info(
    `[Aura latency] ${operation}: ${durationMs.toFixed(2)} ms`
  );
  return durationMs;
}
const sampleOrders = [
  { id: "ORD-101", product: "Vitamin C Serum (30ml)", value: "₹699", status: "Out for Delivery" },
  { id: "ORD-102", product: "Hydrating Sunscreen SPF 50", value: "₹499", status: "Delivered" },
  { id: "ORD-103", product: "Green Tea Face Wash + Toner", value: "₹850", status: "Processing" },
];

export default function App() {
  const [state, setState] = useState("Ready");
  const [orderId, setOrderId] = useState("ORD-101");
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [callActive, setCallActive] = useState(false);
  const [input, setInput] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder));
  const [callSummary, setCallSummary] = useState(null);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [voiceMode, setVoiceMode] = useState("en-IN");

  const historyRef = useRef([]);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);
  const audioRef = useRef(null);
  const callActiveRef = useRef(false);
  const busyRef = useRef(false);
  const conversationRef = useRef([]);
  const callGenerationRef = useRef(0);
  const speechStartedAtRef = useRef(0);
  const lastVoiceMessageRef = useRef({ text: "", at: 0 });
  const bargeInFrameRef = useRef(null);
  const bargeInStartedAtRef = useRef(0);
  const bargeInArmedAtRef = useRef(0);

  useEffect(() => () => {
    callActiveRef.current = false;
    cancelCapture();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    if (audioContextRef.current) void audioContextRef.current.close();
  }, []);

  function addActivity(speaker, text) {
    const entry = { speaker, text, timestamp: new Date().toISOString() };
    historyRef.current = [...historyRef.current, entry];
    setHistory(historyRef.current);
  }

  function classifyIntent(message) {
    const value = (message || "").toLowerCase();
    if (/\b(change|update|set|mark|modify)\b.*\b(status|state)\b|\b(status|state)\b.*\b(change|update|set|mark|modify)\b/.test(value)) return "STATUS_CHANGE_REQUEST";
    if (/\bcancel|cancellation\b/.test(value)) return "CANCELLATION";
    if (/\b(return|refund|send back|defect|damaged|broken)\b/.test(value)) return "RETURN_OR_REFUND";
    if (/cash on delivery|\bcod\b|cash at delivery|payment method|\bupi\b/.test(value)) return "PAYMENT_OR_COD";
    if (/shipping fee|shipping cost|free shipping|delivery fee/.test(value)) return "SHIPPING_POLICY";
    if (/track|tracking|delivery|delivered|shipment|shipped|status/.test(value)) return "ORDER_TRACKING";
    return "GENERAL_SUPPORT";
  }

  function buildCallSummary(entries) {
    const dialogue = entries.filter((item) => item.speaker === "You" || item.speaker === "Aria");
    const transcript = dialogue.map((item) => `${item.speaker}: ${item.text}`).join("\n");
    const customerTurns = dialogue.filter((item) => item.speaker === "You");
    const agentTurns = dialogue.filter((item) => item.speaker === "Aria");

    const orderSummaries = new Map();
    let lastExplicitOrderId = null;
    let lastAgentReply = "";

    const isCallClosing = (message) =>
      /^(end the call|end call|stop the call|goodbye|bye|that's all|that is all)[.!?, ]*$/i.test((message || "").trim());

    const getOrderId = (message) => {
      const match = (message || "").match(/\bORD[\s-]*(\d{3})\b/i);
      return match ? `ORD-${match[1]}` : null;
    };

    const customerMessagesForSummary = customerTurns.filter((item) => !isCallClosing(item.text));
    const meaningfulDialogue = dialogue.filter(
      (item) => item.speaker !== "You" || !isCallClosing(item.text)
    );

    for (let i = 0; i < dialogue.length; i += 1) {
      const item = dialogue[i];
      if (item.speaker === "Aria") {
        lastAgentReply = item.text || "";
        continue;
      }

      const message = (item.text || "").trim();
      if (isCallClosing(message)) continue;

      const explicitId = getOrderId(message);
      if (explicitId) lastExplicitOrderId = explicitId;

      const refersToPreviousOrder = /\b(it|that order|this order|the order)\b/i.test(message);
      const resolvedOrderId = explicitId || (refersToPreviousOrder ? lastExplicitOrderId : null);
      if (!resolvedOrderId) continue;

      if (!orderSummaries.has(resolvedOrderId)) {
        orderSummaries.set(resolvedOrderId, {
          order_id: resolvedOrderId,
          intents: [],
          customer_requests: [],
          agent_responses: [],
          resolution_status: "UNRESOLVED",
        });
      }

      const summary = orderSummaries.get(resolvedOrderId);
      const intent = classifyIntent(message);
      if (!summary.intents.includes(intent)) summary.intents.push(intent);
      summary.customer_requests.push(message);

      // Pair this customer request with the first subsequent Aria response.
      const nextAgent = dialogue.slice(i + 1).find((entry) => entry.speaker === "Aria");
      if (nextAgent?.text && !summary.agent_responses.includes(nextAgent.text)) {
        summary.agent_responses.push(nextAgent.text);
      }

      const responseText = nextAgent?.text || "";
      const needsClarification = /which order|could you repeat|could you clarify|please verify|didn't catch|did not catch/i.test(responseText);
      const actionNotPerformed = /can't change|cannot change|haven't cancelled|have not cancelled|can't modify|cannot modify/i.test(responseText);
      summary.resolution_status = needsClarification
        ? "UNRESOLVED"
        : (actionNotPerformed ? "PARTIALLY_RESOLVED" : "RESOLVED");
    }

    const latestCustomerMessage = customerMessagesForSummary[customerMessagesForSummary.length - 1]?.text || "";
    const customerIntent = latestCustomerMessage ? classifyIntent(latestCustomerMessage) : "GENERAL_SUPPORT";
    const primaryOrderId = getOrderId(latestCustomerMessage)
      || (orderSummaries.size === 1 ? [...orderSummaries.keys()][0] : null);

    const lastMeaningfulAgentReply = [...meaningfulDialogue].reverse().find((item) => item.speaker === "Aria")?.text || "";
    const clarificationNeeded = /which order|could you repeat|could you clarify|please verify|didn't catch|did not catch/i.test(lastMeaningfulAgentReply);
    const actionNotPerformed = /can't change|cannot change|haven't cancelled|have not cancelled|can't modify|cannot modify/i.test(lastMeaningfulAgentReply);
    const resolutionStatus = !customerMessagesForSummary.length || !agentTurns.length || clarificationNeeded
      ? "UNRESOLVED"
      : (actionNotPerformed ? "PARTIALLY_RESOLVED" : "RESOLVED");

    const orderSummaryValues = [...orderSummaries.values()];
    const overallSummary = orderSummaryValues.length
      ? orderSummaryValues.map((item) =>
          `${item.order_id}: intents ${item.intents.join(", ")}. Requests: ${item.customer_requests.join("; ")}. Outcome: ${item.agent_responses.join("; ")}. Status: ${item.resolution_status}.`
        ).join("\n")
      : (customerMessagesForSummary.length
          ? `Latest customer intent: ${customerIntent}. Latest request: ${latestCustomerMessage} Agent outcome: ${lastMeaningfulAgentReply}`.trim()
          : "No customer-agent conversation was captured.");

    return {
      customer_intent: customerIntent,
      order_id: primaryOrderId,
      order_summaries: orderSummaryValues,
      resolution_status: resolutionStatus,
      call_summary: overallSummary,
      transcript,
      generated_at: new Date().toISOString(),
    };
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      addActivity("System", `${label} copied to clipboard.`);
    } catch {
      setError("Clipboard access failed. Select and copy the text manually.");
    }
  }

  function makeSpeechFriendly(text) {
    return text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_>#]/g, "")
      .replace(/\bORD-(\d+)\b/g, "order number O R D $1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cancelCapture() {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
    } catch {}
    recorderRef.current = null;
    chunksRef.current = [];
  }

  async function ensureMicrophone() {
    if (streamRef.current?.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyserRef.current = analyser;
  }

  async function startListening() {
    if (!callActiveRef.current || busyRef.current) return;
    try {
      await ensureMicrophone();
      if (!callActiveRef.current || busyRef.current || recorderRef.current) return;

      const stream = streamRef.current;
      const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
      const recorder = preferredType
        ? new MediaRecorder(stream, { mimeType: preferredType })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      chunksRef.current = [];
      let hasSpeech = false;
      let lastLoudAt = 0;
      const startedAt = Date.now();
      const data = new Uint8Array(analyserRef.current.fftSize);

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        recorderRef.current = null;

        if (!callActiveRef.current || busyRef.current) return;
        // Ignore tiny clips that are likely silence/clicks.
        if (blob.size < 2500) {
          setState("Listening");
          void startListening();
          return;
        }
        await transcribeAndSend(blob);
      };

      recorder.start(250);
      setState("Listening");
      setError("");
      addActivity("System", "Listening. Speak naturally; Aria will respond after a short pause.");

      const detectSilence = () => {
        if (!callActiveRef.current || recorderRef.current !== recorder || recorder.state !== "recording") return;
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();

        if (rms > 0.025) {
          hasSpeech = true;
          lastLoudAt = now;
          speechStartedAtRef.current = now;
        }

        const silenceAfterSpeech = hasSpeech && now - lastLoudAt > 1100;
        const maxDuration = now - startedAt > 25000;
        if (silenceAfterSpeech || maxDuration) {
          if (animationRef.current) cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
          if (recorder.state === "recording") recorder.stop();
          return;
        }
        animationRef.current = requestAnimationFrame(detectSilence);
      };
      animationRef.current = requestAnimationFrame(detectSilence);
    } catch (err) {
      setVoiceSupported(false);
      setState("Ready");
      setError(`Microphone unavailable: ${err.message}. Check browser microphone permission.`);
    }
  }

  async function transcribeAndSend(blob) {
    if (!callActiveRef.current || busyRef.current) return;
    busyRef.current = true;
    setState("Thinking");
    try {
      const sttStartedAt = performance.now();
      const form = new FormData();
      const ext = blob.type.includes("mp4") ? "m4a" : "webm";
      form.append("file", blob, `customer-utterance.${ext}`);
      form.append("voice_mode", voiceMode);
      const response = await fetch(`${API}/voice/transcribe`, { method: "POST", body: form });
      logLatency("sarvam_stt_total", sttStartedAt);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Speech transcription failed.");

      const transcript = (data.transcript || "").trim();
      if (!transcript) throw new Error("I couldn't hear that clearly. Please try again.");

      const now = Date.now();
      const previous = lastVoiceMessageRef.current;
      const normalized = transcript.toLowerCase().replace(/[^a-z0-9]/g, "");
      const previousNormalized = previous.text.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalized === previousNormalized && now - previous.at < 3500) {
        busyRef.current = false;
        setState("Listening");
        void startListening();
        return;
      }
      lastVoiceMessageRef.current = { text: transcript, at: now };
      addActivity("System", `Recognized: “${transcript}”`);
      await sendToAria(transcript, true);
    } catch (err) {
      addActivity("System", `Voice input error: ${err.message}`);
      setError(err.message);
      busyRef.current = false;
      if (callActiveRef.current) void startListening();
    }
  }

  function stopBargeInMonitor() {
    if (bargeInFrameRef.current !== null) {
      cancelAnimationFrame(bargeInFrameRef.current);
      bargeInFrameRef.current = null;
    }
    bargeInStartedAtRef.current = 0;
  }

  function monitorForInterruption(generation, audio) {
    stopBargeInMonitor();
    bargeInArmedAtRef.current = Date.now() + 450;
    const data = new Uint8Array(analyserRef.current?.fftSize || 1024);

    const tick = () => {
      if (
        generation !== callGenerationRef.current ||
        !callActiveRef.current ||
        audio.paused ||
        audio.ended ||
        !analyserRef.current
      ) {
        stopBargeInMonitor();
        return;
      }

      const now = Date.now();
      analyserRef.current.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / data.length);

      // Require sustained foreground speech to reduce false interruptions from
      // short clicks or small background sounds. Headphones improve reliability.
      if (now >= bargeInArmedAtRef.current && rms > 0.075) {
        if (!bargeInStartedAtRef.current) bargeInStartedAtRef.current = now;
        if (now - bargeInStartedAtRef.current >= 280) {
          stopBargeInMonitor();
          audio.pause();
          if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
          audio.src = "";
          busyRef.current = false;
          setState("Listening");
          addActivity("System", "Aria was interrupted. Listening to you.");
          void startListening();
          return;
        }
      } else {
        bargeInStartedAtRef.current = 0;
      }

      bargeInFrameRef.current = requestAnimationFrame(tick);
    };

    bargeInFrameRef.current = requestAnimationFrame(tick);
  }

  async function speakWithSarvam(text, generation) {
    const ttsStartedAt = performance.now();
    const response = await fetch(`${API}/voice/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: makeSpeechFriendly(text), language_code: voiceMode }),
    });
    logLatency("sarvam_tts_request", ttsStartedAt);
    if (!response.ok) {
      let detail = "Sarvam speech synthesis failed.";
      try { detail = (await response.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    if (generation !== callGenerationRef.current || !callActiveRef.current) return;

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src.startsWith("blob:")) URL.revokeObjectURL(audioRef.current.src);
    }
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    setState("Speaking");
    audio.onended = () => {
      stopBargeInMonitor();
      URL.revokeObjectURL(audioUrl);
      if (generation !== callGenerationRef.current) return;
      busyRef.current = false;
      if (callActiveRef.current) void startListening();
      else setState("Ready");
    };
    audio.onerror = () => {
      stopBargeInMonitor();
      URL.revokeObjectURL(audioUrl);
      if (generation !== callGenerationRef.current) return;
      busyRef.current = false;
      setError("Could not play Aria's audio. Check browser audio settings.");
      if (callActiveRef.current) void startListening();
      else setState("Ready");
    };
    await audio.play();
    monitorForInterruption(generation, audio);
  }

  async function lookupOrder(id = orderId) {
    const normalizedId = id.trim().toUpperCase();
    if (!normalizedId) {
      setError("Enter an order ID first.");
      return;
    }
    setOrderId(normalizedId);
    setError("");
    setState("Thinking");
    setOrder(null);
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(normalizedId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Order not found.");
      setOrder(data);
      addActivity("System", `Successfully retrieved ${data.order_id}.`);
      setState(callActiveRef.current ? "Listening" : "Ready");
    } catch (err) {
      setError(err.message === "Failed to fetch"
        ? "Cannot reach the backend. Check that FastAPI is running."
        : err.message);
      setState(callActiveRef.current ? "Listening" : "Ready");
    }
  }

  async function sendToAria(text, alreadyBusy = false) {
    const message = text.trim();
    if (!message || (busyRef.current && !alreadyBusy)) return;
    busyRef.current = true;
    const generation = callGenerationRef.current;
    cancelCapture();
    setError("");
    setState("Thinking");
    addActivity("You", message);
    const previousMessages = [...conversationRef.current];

    try {
      const chatStartedAt = performance.now();
      const response = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: previousMessages.slice(-10), language_code: voiceMode }),
      });
      logLatency("chat_total", chatStartedAt);
      const data = await response.json();
      if (generation !== callGenerationRef.current) return;
      if (!response.ok) throw new Error(data.detail || "Unable to contact Aria.");
      const reply = data.reply || "Sorry, I couldn't generate a response.";

      conversationRef.current = [
        ...previousMessages,
        { role: "user", text: message },
        { role: "assistant", text: reply },
      ];
      addActivity("Aria", reply);

      if (callActiveRef.current) {
        try {
          await speakWithSarvam(reply, generation);
        } catch (ttsError) {
          // Use Sarvam for voice output; do not silently switch providers.
          console.error("[Sarvam TTS]", ttsError);
          addActivity("System", `Sarvam TTS error: ${ttsError.message}`);
          setError(`Sarvam could not generate speech: ${ttsError.message}`);
          busyRef.current = false;
          if (callActiveRef.current) void startListening();
          else setState("Ready");
        }
      } else {
        busyRef.current = false;
        setState("Ready");
      }
    } catch (err) {
      if (generation !== callGenerationRef.current) return;
      addActivity("System", `Error: ${err.message}`);
      setError(err.message === "Failed to fetch"
        ? "Cannot reach Aria. Check that FastAPI is running."
        : err.message);
      busyRef.current = false;
      setState(callActiveRef.current ? "Listening" : "Ready");
      if (callActiveRef.current) void startListening();
    }
  }

  async function startCall() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceSupported(false);
      setError("This browser does not support audio recording. Use the latest Chrome over localhost or HTTPS.");
      return;
    }
    callGenerationRef.current += 1;
    busyRef.current = false;
    setHistory([]);
    historyRef.current = [];
    setCallSummary(null);
    setSummaryVisible(false);
    setOrder(null);
    setError("");
    setInput("");
    conversationRef.current = [];
    callActiveRef.current = true;
    setCallActive(true);
    setState("Listening");
    try {
      await ensureMicrophone();
      if (!callActiveRef.current) return;
      addActivity("System", "Voice call started. Speak after the microphone activates.");
      void startListening();
    } catch (err) {
      callActiveRef.current = false;
      setCallActive(false);
      setState("Ready");
      setError(`Could not start microphone: ${err.message}`);
    }
  }

  function endCall() {
    // Build the summary from the conversation before adding the system end marker.
    const summary = buildCallSummary(historyRef.current);
    setCallSummary(summary);
    setSummaryVisible(true);

    callGenerationRef.current += 1;
    stopBargeInMonitor();
    callActiveRef.current = false;
    setCallActive(false);
    busyRef.current = false;
    cancelCapture();
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src.startsWith("blob:")) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current.src = "";
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setState("Ready");
    addActivity("System", "Call ended. Summary generated.");
  }

  function submitText(event) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;
    setInput("");
    sendToAria(message);
  }

  return (
    <main className="app-shell aura-redesign">
      <header className="topbar aura-topbar">
        <a className="brand aura-brand" href="#" aria-label="Aura Skincare home">
          <span className={`aura-mark aura-mark-${state.toLowerCase()}`} aria-hidden="true">
            <svg viewBox="0 0 64 64" role="img" aria-label="">
              <path d="M32 7 C38 18 39 22 32 29 C25 22 26 18 32 7Z" />
              <path d="M57 32 C46 38 42 39 35 32 C42 25 46 26 57 32Z" />
              <path d="M32 57 C26 46 25 42 32 35 C39 42 38 46 32 57Z" />
              <path d="M7 32 C18 26 22 25 29 32 C22 39 18 38 7 32Z" />
              <circle cx="32" cy="32" r="5" />
            </svg>
          </span>
          <span className="brand-wordmark"><strong>AURA</strong><small>SKINCARE · CUSTOMER CARE</small></span>
        </a>
        <span className="top-label"><span className="top-label-dot" /> AI CUSTOMER EXPERIENCE</span>
      </header>

      <section className="hero aura-hero">
        <div className="hero-copy">
          <p className="eyebrow">YOUR PERSONAL SUPPORT ASSISTANT</p>
          <h1>Care that <em>listens.</em></h1>
          <p className="subtitle">Meet Aria, your Aura Skincare support companion. Ask about orders, delivery, returns, or payment policies.</p>
        </div>
        <div className={`voice-console voice-console-${state.toLowerCase()}`}>
          <div className={`aria-orb aria-orb-${state.toLowerCase()}`} aria-label={`Aria is ${state.toLowerCase()}`}>
            <span className="orb-halo orb-halo-one" />
            <span className="orb-halo orb-halo-two" />
            <span className="orb-core">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <path d="M32 9 C38 19 39 23 32 29 C25 23 26 19 32 9Z" />
                <path d="M55 32 C45 38 41 39 35 32 C41 25 45 26 55 32Z" />
                <path d="M32 55 C26 45 25 41 32 35 C39 41 38 45 32 55Z" />
                <path d="M9 32 C19 26 23 25 29 32 C23 39 19 38 9 32Z" />
                <circle cx="32" cy="32" r="4.5" />
              </svg>
            </span>
          </div>
          <div className="voice-console-copy">
            <span className={`state-pill state-pill-${state.toLowerCase()}`}>
              <span className="state-dot" /> {state === "Ready" ? "Ready to help" : state === "Listening" ? "Listening to you" : state === "Thinking" ? "Thinking through it" : state === "Speaking" ? "Aria is speaking" : state}
            </span>
            <h2>Aria</h2>
            <p>{state === "Listening" ? "Go ahead — I'm listening." : state === "Thinking" ? "Let me find the right answer." : state === "Speaking" ? "Here's what I found for you." : "Friendly support, whenever you need it."}</p>
            <div className="voice-mode-row">
              <label htmlFor="voice-mode">Voice language</label>
              <select id="voice-mode" value={voiceMode} onChange={(event) => setVoiceMode(event.target.value)} disabled={callActive}>
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">Hindi (हिन्दी)</option>
              </select>
            </div>
            <div className="call-actions aura-call-actions">
              <button className="primary-button" onClick={startCall} disabled={callActive}><span>▶</span> Start Call</button>
              <button className="secondary-button" onClick={endCall} disabled={!callActive}><span>■</span> End Call</button>
            </div>
            <p className="helper-text">{voiceSupported ? "Sarvam voice is enabled. Pause briefly after speaking." : "Voice recording is unavailable. You can still use text chat."}</p>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <section className="panel transcript-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">LIVE CONVERSATION</p><h2>Conversation transcript</h2></div>
            <span className="live-indicator"><span /> {callActive ? "LIVE" : "CALL LOG"}</span>
          </div>
          {!history.some((item) => item.speaker === "You" || item.speaker === "Aria") ? (
            <div className="empty-state transcript-empty">
              <div className="empty-icon">✳</div>
              <h3>Your conversation starts here</h3>
              <p>Start a call or type a message to see the transcript.</p>
            </div>
          ) : (
            <div className="activity-list transcript-list" aria-live="polite">
              {history.filter((item) => item.speaker === "You" || item.speaker === "Aria").map((item, index) => (
                <div className={`transcript-message transcript-${item.speaker.toLowerCase()}`} key={`${item.timestamp || "msg"}-${index}`}>
                  <div className="transcript-avatar">{item.speaker === "You" ? "Y" : "✿"}</div>
                  <div className="transcript-bubble">
                    <div className="transcript-meta"><strong>{item.speaker === "You" ? "You" : "Aria"}</strong><span>{item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
                    <p>{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && <div className="error-message">{error}</div>}
          <form className="chat-form transcript-composer" onSubmit={submitText}>
            <label htmlFor="chat-message">Or type your message</label>
            <div className="search-row">
              <input id="chat-message" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about an order or policy..." />
              <button className="primary-button" type="submit" disabled={!input.trim() || state === "Thinking"}>Send ↗</button>
            </div>
          </form>
        </section>

        <aside className="panel summary-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">AFTER THE CALL</p><h2>Call summary</h2></div>
            <span className="panel-icon">✧</span>
          </div>
          {!summaryVisible || !callSummary ? (
            <div className="summary-placeholder">
              <div className="summary-placeholder-icon">✧</div>
              <h3>Your call, thoughtfully summarized.</h3>
              <p>End the call to generate a structured summary of customer intent, order details, and resolution.</p>
            </div>
          ) : (
            <>
              <div className="summary-topline">
                <span className={`summary-status summary-status-${String(callSummary.resolution_status || "").toLowerCase()}`}>{callSummary.resolution_status}</span>
              </div>
              <div className="summary-json-card">
                <div className="summary-field">
                  <span className="summary-field-label">Customer intent</span>
                  <strong>{callSummary.customer_intent}</strong>
                </div>
                <div className="summary-field">
                  <span className="summary-field-label">Primary order</span>
                  <strong>{callSummary.order_id || "Not identified"}</strong>
                </div>
                <div className="summary-field summary-field-full">
                  <span className="summary-field-label">Call summary</span>
                  <p>{callSummary.call_summary}</p>
                </div>
              </div>
              {callSummary.order_summaries?.length > 0 && (
                <div className="order-summary-list">
                  <h3>Orders discussed</h3>
                  {callSummary.order_summaries.map((item) => (
                    <article className="order-summary-card" key={item.order_id}>
                      <div className="order-summary-card-heading">
                        <strong>{item.order_id}</strong>
                        <span className={`summary-status summary-status-${String(item.resolution_status || "").toLowerCase()}`}>{item.resolution_status}</span>
                      </div>
                      <p><strong>Intent:</strong> {item.intents.join(", ")}</p>
                      <p><strong>Outcome:</strong> {item.agent_responses.join(" ")}</p>
                    </article>
                  ))}
                </div>
              )}
              <div className="summary-actions">
                <button className="secondary-button" type="button" onClick={() => copyText(callSummary.transcript, "Transcript")}>Copy transcript</button>
                <button className="primary-button" type="button" onClick={() => copyText(JSON.stringify({
                  customer_intent: callSummary.customer_intent,
                  order_id: callSummary.order_id,
                  resolution_status: callSummary.resolution_status,
                  call_summary: callSummary.call_summary,
                }, null, 2), "JSON summary")}>Copy JSON</button>
              </div>
              <details className="summary-details">
                <summary>View structured JSON</summary>
                <pre className="summary-json">{JSON.stringify({
                  customer_intent: callSummary.customer_intent,
                  order_id: callSummary.order_id,
                  resolution_status: callSummary.resolution_status,
                  call_summary: callSummary.call_summary,
                }, null, 2)}</pre>
              </details>
            </>
          )}
        </aside>
      </section>

      <section className="panel order-management-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">ORDER MANAGEMENT</p><h2>Explore sample orders</h2><p className="panel-subtitle">Select any order to inspect its details, or use the ID in your conversation with Aria.</p></div>
          <span className="panel-icon">↗</span>
        </div>
        <div className="order-management-layout">
          <div className="sample-orders-grid">
            {sampleOrders.map((item) => (
              <button className={`sample-order-card ${orderId === item.id ? "sample-order-selected" : ""}`} key={item.id} onClick={() => { setOrderId(item.id); void lookupOrder(item.id); }}>
                <div className="sample-card-top"><span className="sample-order-id">{item.id}</span><span className="sample-order-arrow">↗</span></div>
                <strong className="sample-product">{item.product}</strong>
                <div className="sample-card-bottom"><strong>{item.value}</strong><span className={`order-status status-${item.status.toLowerCase().replaceAll(" ", "-")}`}>{item.status}</span></div>
              </button>
            ))}
          </div>
          <div className="order-lookup-box">
            <h3>Look up an order</h3>
            <p>Have a specific order ID? Enter it below.</p>
            <form onSubmit={(event) => { event.preventDefault(); void lookupOrder(); }}>
              <label htmlFor="order-id">Order ID</label>
              <div className="search-row">
                <input id="order-id" value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="e.g. ORD-101" />
                <button className="primary-button" type="submit">Look up</button>
              </div>
            </form>
            {order && (
              <div className="order-result order-result-modern">
                <div className="result-header"><strong>{order.order_id}</strong><span className="status-badge">{order.status}</span></div>
                <p>{order.product}</p>
                <p><strong>Order value:</strong> ₹{order.value}</p>
                {order.courier && <p><strong>Courier:</strong> {order.courier}</p>}
                {order.tracking_id && <p><strong>Tracking ID:</strong> {order.tracking_id}</p>}
                {order.delivery_note && <p>{order.delivery_note}</p>}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="aura-footer"><span className="footer-mark">✿</span> Aura Skincare <span>·</span> Thoughtful care, thoughtful support.</footer>
    </main>
  );
}
