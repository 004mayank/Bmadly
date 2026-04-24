"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL, PROVIDERS } from "../lib/config";

type ProviderId = (typeof PROVIDERS)[number]["id"];

type RunResponse = { runId: string; status: string };

type RunState =
  | { status: "idle" }
  | { status: "running"; runId: string }
  | { status: "done"; runId: string; finalStatus: "succeeded" | "failed" }
  | { status: "error"; message: string };

type KeyStatus = "idle" | "dirty" | "testing" | "ok" | "saved" | "error";

type RunBanner = null | { title: string; subtitle?: string; ts: number };

type Stage =
  | "Idle"
  | "Creating run"
  | "Starting runtime"
  | "Authenticating runtime"
  | "Running pipeline"
  | "Starting agent"
  | "Agent thinking"
  | "Done"
  | "Error";

type BmadMenuItem = { code: string; description: string; skill?: string; prompt?: string };
type BmadChatMessage = { role: "user" | "assistant"; text: string; ts: number };
type BmadSession = {
  id: string;
  runId: string;
  agentSkillId?: string;
  activeSkillId?: string;
  step?: { kind: string; index: number; total?: number };
  messages: BmadChatMessage[];
  artifacts: Array<{ id: string; type: string; title?: string; content: string; createdAt: number }>;
  // Canonical "current document" pointer (preferred).
  // Provided by backend on session responses.
  primaryArtifactId?: string | null;
};

type BmadAgent = { id: string; label: string; title?: string };

const BMAD_METHOD_AGENTS: BmadAgent[] = [
  { id: "bmad-agent-analyst", label: "Mary", title: "Analyst" },
  { id: "bmad-agent-pm", label: "John", title: "Product Manager" },
  { id: "bmad-agent-ux-designer", label: "Sally", title: "UX Designer" },
  { id: "bmad-agent-architect", label: "Winston", title: "System Architect" },
  { id: "bmad-agent-dev", label: "Amelia", title: "Developer" },
  { id: "bmad-agent-tech-writer", label: "Paige", title: "Tech Writer" }
];

export default function HomePage() {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  // Default to BYOK for best UX.
  // Note: BMAD Chat currently requires BYOK.
  const [useOwnKey, setUseOwnKey] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("idle");
  const [keyStatusMsg, setKeyStatusMsg] = useState<string>("");
  const [idea, setIdea] = useState("");
  const [runBanner, setRunBanner] = useState<RunBanner>(null);
  const [stage, setStage] = useState<Stage>("Idle");
  const [stageDetail, setStageDetail] = useState<string>("");

  const [logs, setLogs] = useState<string[]>([]);
  const [output, setOutput] = useState<string>("");
  const [planJson, setPlanJson] = useState<string>("");
  const [reviewText, setReviewText] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [analysisMd, setAnalysisMd] = useState<string>("");
  const [prdMd, setPrdMd] = useState<string>("");
  const [bmadArtifactsFromRun, setBmadArtifactsFromRun] = useState<
    Array<{ id: string; type: string; title?: string; contentType: string; content: string; createdAt: number }>
  >([]);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  // --- BMAD Chat state (attached to current runId) ---
  const [bmadSession, setBmadSession] = useState<BmadSession | null>(null);
  const [bmadMenu, setBmadMenu] = useState<BmadMenuItem[] | null>(null);
  const [bmadChatInput, setBmadChatInput] = useState<string>("");
  const [bmadStatus, setBmadStatus] = useState<string>("");
  const [bmadBusy, setBmadBusy] = useState(false);
  const [bmadErrorBanner, setBmadErrorBanner] = useState<string>("");
  const [bmadAgentSkillId, setBmadAgentSkillId] = useState<string>("bmad-agent-analyst");
  const [bmadDebugOpen, setBmadDebugOpen] = useState(false);
  const [bmadDebugJson, setBmadDebugJson] = useState<string>("");

  const [activeView, setActiveView] = useState<"environment" | "agents" | "export">("environment");

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const bmadChatRef = useRef<HTMLDivElement | null>(null);

  const providerConfig = useMemo(() => PROVIDERS.find((p) => p.id === provider)!, [provider]);

  useEffect(() => {
    // reset model to first for provider when provider changes
    setModel(providerConfig.models[0]);
  }, [providerConfig]);

  // --- BYOK persistence (browser-only) ---
  // Store per-provider to reduce accidental cross-provider usage.
  const apiKeyStorageKey = useMemo(() => `bmadly.apiKey.${provider}`, [provider]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(apiKeyStorageKey) || "";
      if (saved) {
        setApiKey(saved);
        setKeyStatus("saved");
        setKeyStatusMsg("Saved");
      } else {
        setKeyStatus("idle");
        setKeyStatusMsg("");
      }
    } catch {
      // ignore (private mode / blocked storage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyStorageKey]);

  // Mark unsaved changes when user edits the key.
  useEffect(() => {
    if (!apiKey) {
      if (keyStatus !== "idle") {
        setKeyStatus("idle");
        setKeyStatusMsg("");
      }
      return;
    }
    if (keyStatus === "saved" || keyStatus === "testing") return;
    setKeyStatus("dirty");
  }, [apiKey]);

  function saveApiKey() {
    try {
      localStorage.setItem(apiKeyStorageKey, apiKey);
      setKeyStatus("saved");
      setKeyStatusMsg("Saved");
      setLogs((l) => [...l, `[ui] saved API key locally for ${provider}`]);
    } catch {
      setKeyStatus("error");
      setKeyStatusMsg("Storage unavailable");
      setLogs((l) => [...l, `[ui] failed to save API key (storage unavailable)`]);
    }
  }

  function clearSavedApiKey() {
    try {
      localStorage.removeItem(apiKeyStorageKey);
    } catch {
      // ignore
    }
    setApiKey("");
    setKeyStatus("idle");
    setKeyStatusMsg("");
    setLogs((l) => [...l, `[ui] cleared saved API key for ${provider}`]);
  }

  async function testApiKey() {
    if (apiKey.trim().length < 8) return;
    setKeyStatus("testing");
    setKeyStatusMsg("Testing…");
    try {
      // Use runtime auth as a lightweight key check.
      // Needs a runId; create one if none exists.
      let runId = currentRunId;
      if (!runId) {
        const r = await fetch(`${API_BASE_URL}/api/pipeline/create`, { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `Failed to create run (${r.status})`);
        runId = String(j.runId);
        // keep a runId badge so Agent tab can activate
        setRunState({ status: "done", runId, finalStatus: "succeeded" });
      }

      const ar = await fetch(`${API_BASE_URL}/api/runtime/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, provider, model, apiKey })
      });
      const aj = await ar.json().catch(() => ({}));
      if (!ar.ok) throw new Error(aj?.error || `Auth failed (${ar.status})`);

      // Only consider the key verified once it is also saved.
      setKeyStatus("ok");
      setKeyStatusMsg("Key OK (save to enable Agent Chat)");
      setLogs((l) => [...l, "[ui] key test succeeded"]);
    } catch (e: any) {
      setKeyStatus("error");
      setKeyStatusMsg(e?.message || "Test failed");
      setLogs((l) => [...l, `[ui] key test failed: ${e?.message || "error"}`]);
    }
  }

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [logs]);

  useEffect(() => {
    bmadChatRef.current?.scrollTo({ top: bmadChatRef.current.scrollHeight });
  }, [bmadSession?.messages?.length]);

  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 250);
    return () => clearInterval(t);
  }, [startedAt]);

  function clearPanels() {
    setLogs([]);
    setOutput("");
    setPlanJson("");
    setReviewText("");
    setPreviewUrl("");
    setAnalysisMd("");
    setPrdMd("");
    setBmadArtifactsFromRun([]);
    setRunState({ status: "idle" });
    setStartedAt(null);
    setElapsedSec(0);

    setBmadSession(null);
    setBmadMenu(null);
    setBmadChatInput("");
    setBmadStatus("");
  }

  async function ensureBmadSessionForRun(runId: string) {
    if (bmadSession?.runId === runId) return bmadSession;
    setBmadStatus("Creating BMAD session…");

    // Prefer resuming the most recent existing session for this run.
    const list = await fetch(`${API_BASE_URL}/api/bmad/sessions?runId=${encodeURIComponent(runId)}`);
    if (list.ok) {
      const lj = await list.json().catch(() => null);
      const sessions = (lj?.sessions ?? []) as BmadSession[];
      if (sessions.length) {
        setBmadSession(sessions[0]);
        setBmadStatus("Resumed BMAD session");
        return sessions[0];
      }
    }

    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j?.error || `Failed to create BMAD session (${resp.status})`);
    }
    const j = await resp.json();
    setBmadSession(j.session as BmadSession);
    setBmadStatus("BMAD session ready");
    return j.session as BmadSession;
  }

  async function startBmadAgent() {
    let runId = currentRunId;
    if (!runId) {
      setBmadStatus("Creating run…");
      const r = await fetch(`${API_BASE_URL}/api/pipeline/create`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to create run (${r.status})`);
      runId = String(j.runId);
      // Keep local runState so the runId badge shows up.
      setRunState({ status: "done", runId, finalStatus: "succeeded" });
    }
    // For BMAD chat: require BYOK for now.
    if (apiKey.trim().length < 8) {
      setBmadStatus("Enter your API key to start BMAD chat.");
      return;
    }
    const s = await ensureBmadSessionForRun(runId);

    // Seed context so the agent doesn't ask the user to restate the idea.
    // This is a lightweight "first user turn" that pins the project in the chat history.
    if (idea.trim()) {
      setBmadSession((prev) => {
        if (!prev) return prev;
        const alreadySeeded = prev.messages?.some((m) => m.role === "user" && m.text.startsWith("Project:"));
        if (alreadySeeded) return prev;
        return {
          ...prev,
          messages: [...(prev.messages || []), { role: "user", text: `Project: ${idea.trim()}`, ts: Date.now() }]
        };
      });
    }

    setBmadErrorBanner("");
    setStage("Starting agent");
    setStageDetail("");
    setBmadBusy(true);
    setBmadStatus("Starting agent…");
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: s.id,
        agentSkillId: bmadAgentSkillId,
        provider,
        model,
        apiKey,
        // best-effort extra context; backend may ignore
        idea
      })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      setBmadBusy(false);
      setStage("Error");
      setStageDetail(j?.error || `Failed to start agent (${resp.status})`);
      throw new Error(j?.error || `Failed to start agent (${resp.status})`);
    }
    const j = await resp.json();
    setBmadMenu(j.menu as BmadMenuItem[]);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    setBmadBusy(false);
    setBmadStatus("Agent started");
    setStage("Idle");
    setStageDetail("");
  }

  async function selectBmadSkill(skillId: string) {
    if (!bmadSession) return;
    setBmadStatus(`Selected ${skillId}`);
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/select-skill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: bmadSession.id, skillId })
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j?.error || `Failed to select skill (${resp.status})`);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
  }

  async function sendBmadChat(overrideMessage?: string) {
    if (!bmadSession) {
      setBmadStatus("Start an agent first.");
      return;
    }
    const msg = (overrideMessage ?? bmadChatInput).trim();
    if (!msg) return;

    if (apiKey.trim().length < 8) {
      setBmadStatus("Enter your API key to chat.");
      return;
    }

    setBmadErrorBanner("");
    setStage("Agent thinking");
    setStageDetail("");
    setBmadBusy(true);
    setBmadChatInput("");
    setBmadStatus("Thinking…");
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: bmadSession.id,
        message: msg,
        provider,
        model,
        apiKey
      })
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setBmadBusy(false);
      const msg = j?.error || `BMAD message failed (${resp.status})`;
      setBmadErrorBanner(msg);
      setStage("Error");
      setStageDetail(msg);
      throw new Error(msg);
    }
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    if (bmadDebugOpen) {
      fetchBmadDebug((j.session as BmadSession).id).catch(() => {});
    }
    setBmadBusy(false);
    setBmadStatus("Ready");
    setStage("Idle");
    setStageDetail("");
  }

  async function fetchBmadDebug(sessionId: string) {
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/${encodeURIComponent(sessionId)}/debug`);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j?.error || `Debug failed (${resp.status})`);
    setBmadDebugJson(JSON.stringify(j, null, 2));
  }

  async function startRun() {
    setOutput("");
    setLogs([]);
    setPlanJson("");
    setReviewText("");
    setPreviewUrl("");
    setAnalysisMd("");
    setPrdMd("");
    setStartedAt(Date.now());
    setElapsedSec(0);
    setStage("Running pipeline");
    setStageDetail("");

    if (!provider || !model) {
      setRunState({ status: "error", message: "Select provider and model." });
      setStage("Error");
      setStageDetail("Select provider and model.");
      return;
    }

    if (!idea.trim()) {
      setRunState({ status: "error", message: "Enter a product idea." });
      setStage("Error");
      setStageDetail("Enter a product idea.");
      return;
    }

    if (useOwnKey && apiKey.trim().length < 8) {
      setRunState({ status: "error", message: "BYOK is enabled but API key is missing." });
      setStage("Error");
      setStageDetail("API key missing.");
      return;
    }

    try {
      const resp = await fetch(`${API_BASE_URL}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          useOwnKey,
          apiKey: useOwnKey ? apiKey : undefined,
          input: { idea }
        })
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j?.error || `Request failed (${resp.status})`);
      }

      const data = (await resp.json()) as RunResponse;
      setRunState({ status: "running", runId: data.runId });

      // Nudge user into Agent Chat after execution begins.
      setRunBanner({
        title: `Wonderful, lets build “${idea.trim()}”`,
        subtitle: "Opening Agent Chat…",
        ts: Date.now()
      });
      setActiveView("agents");

      // One-time runtime auth handshake (stores BYOK in the per-run container memory).
      if (useOwnKey) {
        setStage("Authenticating runtime");
        setStageDetail("");
        setLogs((l) => [...l, "[ui] authenticating runtime…"]);
        const ar = await fetch(`${API_BASE_URL}/api/runtime/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: data.runId, provider, model, apiKey })
        });
        const aj = await ar.json().catch(() => ({}));
        if (!ar.ok) {
          setLogs((l) => [...l, `[ui] runtime auth failed: ${aj?.error || ar.status}`]);
          setStage("Error");
          setStageDetail(String(aj?.error || ar.status));
        } else {
          setLogs((l) => [...l, "[ui] runtime authenticated"]);
          setStage("Running pipeline");
          setStageDetail("");
        }
      }

      streamLogs(data.runId);
    } catch (e: any) {
      setStartedAt(null);
      setRunState({ status: "error", message: e?.message || "Failed to start run" });
      setStage("Error");
      setStageDetail(e?.message || "Failed to start run");
    }
  }

  async function streamLogs(runId: string) {
    const es = new EventSource(`${API_BASE_URL}/api/run/${runId}/stream`);

    es.addEventListener("log", (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data);
      setLogs((prev) => [...prev, msg.line]);

      // Heuristic: surface common fatal runtime failures in the Agent Chat UI.
      const line = String(msg.line || "");
      if (line.toLowerCase().includes("creating") && line.toLowerCase().includes("container")) {
        setStage("Starting runtime");
        setStageDetail("");
      }
      if (line.toLowerCase().includes("pull") && line.toLowerCase().includes("image")) {
        setStage("Starting runtime");
        setStageDetail("Pulling image");
      }
      if (
        line.includes("port is already allocated") ||
        line.includes("EADDRINUSE") ||
        line.toLowerCase().includes("runtime container failed")
      ) {
        setBmadErrorBanner(line);
        setBmadStatus("Runtime error");
        setStage("Error");
        setStageDetail(line);
        setBmadBusy(false);
      }
    });

    es.addEventListener("done", async (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data);
      es.close();

      const finalStatus = msg.status as "succeeded" | "failed";
      setRunState({ status: "done", runId, finalStatus });
      setStartedAt(null);

      // fetch result
      const r = await fetch(`${API_BASE_URL}/api/run/${runId}/result`);
      const j = await r.json().catch(() => null);
      const result = j?.output;
      if (result?.artifacts?.analysis?.content) setAnalysisMd(String(result.artifacts.analysis.content));
      if (result?.artifacts?.prd?.content) setPrdMd(String(result.artifacts.prd.content));
      if (Array.isArray(result?.artifacts?.bmad)) setBmadArtifactsFromRun(result.artifacts.bmad);
      if (result?.plan) setPlanJson(JSON.stringify(result.plan, null, 2));
      if (result?.review) setReviewText(JSON.stringify(result.review, null, 2));
      // live preview URL may be absolute (http://localhost:PORT)
      if (j?.previewUrl) setPreviewUrl(String(j.previewUrl));
      setOutput(JSON.stringify(result ?? null, null, 2));

      // If we reached done, clear any transient busy flags.
      setBmadBusy(false);
      setStage("Done");
      setStageDetail(finalStatus);
    });

    es.onerror = () => {
      es.close();
      setStartedAt(null);
      setRunState({ status: "error", message: "Stream disconnected." });
      setBmadBusy(false);
      setStage("Error");
      setStageDetail("Stream disconnected");
    };
  }

  const isRunning = runState.status === "running";
  const currentRunId =
    runState.status === "running"
      ? runState.runId
      : runState.status === "done"
        ? runState.runId
        : null;

  // Gate Agent Chat tab: require a runId, a product idea, and a tested+saved key.
  const canOpenAgentChat = useMemo(() => {
    return Boolean(currentRunId && idea.trim().length > 0 && keyStatus === "saved");
  }, [currentRunId, idea, keyStatus]);

  const elapsedLabel = useMemo(() => {
    const s = elapsedSec;
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [elapsedSec]);

  return (
    <main className="containerFull">

      <div className="appShell">
        <aside className="leftRail">
          <div className="brandRow">
            <div>
              <div className="brandName" style={{ fontSize: 22, letterSpacing: 0.2 }}>BMADly</div>
            </div>
          </div>

          <div className="railBlock">
            <div className="railBlockTitle">MISSION_CONTROL</div>
            <div className="railBlockSub">v0.1.0</div>
          </div>
          <button className={`navItem ${activeView === "environment" ? "navItemActive" : ""}`} type="button" onClick={() => setActiveView("environment")}>
            <span>Environment</span>
          </button>
          <button
            className={`navItem ${activeView === "agents" ? "navItemActive" : ""} ${!canOpenAgentChat ? "navItemDisabled" : ""}`}
            type="button"
            disabled={!canOpenAgentChat}
            onClick={() => canOpenAgentChat && setActiveView("agents")}
          >
            <span>Agent Chat</span>
          </button>
          <button
            className={`navItem ${activeView === "export" ? "navItemActive" : ""} ${!currentRunId ? "navItemDisabled" : ""}`}
            type="button"
            disabled={!currentRunId}
            onClick={() => currentRunId && setActiveView("export")}
          >
            <span>Export</span>
          </button>
        </aside>

        <div>
          <div className="topBar">
            <div className="tabsRow">
              <div className="tab tabActive">EXECUTION</div>
              <div className="tab">ANALYTICS</div>
              <div className="tab">MODELS</div>
            </div>

            <div className="row" style={{ justifyContent: "flex-end" }}>
              <div className="chip">
                <span className={currentRunId ? "ok" : "muted"}>●</span>
                <span>System Ready</span>
              </div>
              <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12, marginRight: 10 }}>Latency: 24ms</div>
              <button className="btnRun" type="button" onClick={startRun} disabled={isRunning}>
                RUN BMAD
              </button>
            </div>
          </div>

          {activeView === "environment" ? (
            <div style={{ padding: "0 22px 22px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div className="pageTitle">Environment Setup</div>
                  <p className="pageSubtitle">Initialize your model orchestration parameters to begin execution.</p>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="chip">
                    <span className={currentRunId ? "ok" : "muted"}>●</span>
                    <span>System Ready</span>
                  </div>
                  <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>Latency: 24ms</div>
                </div>
              </div>

              <div className="cards2" style={{ marginTop: 16 }}>
                <section className="card">
                  <div className="cardTitle">
                    <div className="cardTitleText">GLOBAL CONFIGURATION</div>
                  </div>

                  <div className="split2">
                    <div>
                      <label className="label">LLM Provider</label>
                      <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} disabled={isRunning}>
                        {PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">Model Version</label>
                      <select className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={isRunning}>
                        {providerConfig.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <label className="label">Product idea</label>
                  <textarea
                    className="input"
                    value={idea}
                    disabled={isRunning}
                    onChange={(e) => setIdea(e.target.value)}
                    placeholder="Describe the product you want to generate…"
                    style={{ minHeight: 92, resize: "vertical" }}
                  />

                  <label className="label">API Key</label>
                  <input className="input" type="password" value={apiKey} disabled={isRunning} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
                  <div className="row" style={{ marginTop: 10, gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button
                      className="btnSecondary"
                      type="button"
                      disabled={isRunning || apiKey.trim().length < 8 || keyStatus === "testing"}
                      onClick={testApiKey}
                      title="Validates your key by attempting a runtime auth handshake."
                    >
                      TEST KEY
                    </button>
                    <button
                      className="btnSecondary"
                      type="button"
                      disabled={isRunning || apiKey.trim().length < 8 || keyStatus === "testing"}
                      onClick={saveApiKey}
                      title="Stores your key in this browser only (localStorage)."
                    >
                      SAVE KEY
                    </button>
                    <div className="pill" title={keyStatusMsg || ""}>
                      <span className={keyStatus === "saved" || keyStatus === "ok" ? "ok" : keyStatus === "error" ? "err" : "muted"}>●</span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {keyStatus === "saved"
                          ? "Saved"
                          : keyStatus === "ok"
                            ? "Key OK"
                            : keyStatus === "testing"
                              ? "Testing"
                              : keyStatus === "dirty"
                                ? "Not saved"
                                : keyStatus === "error"
                                  ? "Error"
                                  : ""}
                      </span>
                    </div>
                    <button
                      className="btnSecondary"
                      type="button"
                      disabled={isRunning}
                      onClick={clearSavedApiKey}
                      title="Clears the saved key for this provider from this browser."
                    >
                      CLEAR
                    </button>
                  </div>
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    Key is stored locally in your browser (localStorage) and is not sent anywhere except to call the selected provider.
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                    {runState.status === "error" ? (
                      <div className="err" style={{ marginRight: 12, alignSelf: "center" }}>
                        {runState.message}
                      </div>
                    ) : runState.status === "running" ? (
                      <div className="muted" style={{ marginRight: 12, alignSelf: "center", fontFamily: "var(--mono)", fontSize: 12 }}>
                        Running… {elapsedLabel}
                      </div>
                    ) : runState.status === "done" ? (
                      <div className={runState.finalStatus === "succeeded" ? "ok" : "err"} style={{ marginRight: 12, alignSelf: "center", fontFamily: "var(--mono)", fontSize: 12 }}>
                        {runState.finalStatus.toUpperCase()} • {currentRunId}
                      </div>
                    ) : null}
                    <button className="btnRun" type="button" onClick={startRun} disabled={isRunning}>
                      RUN BMAD EXECUTION
                    </button>
                  </div>
                </section>

                <div style={{ display: "grid", gap: 16 }}>
                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">Setup Guide</div>
                    </div>
                    <div className="muted" style={{ lineHeight: 1.6 }}>
                      New to BMAD? Follow the quickstart guide to calibrate your agents.
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                      <span className="badge">CORE-V2</span>
                      <span className="badge">RUNTIME</span>
                    </div>
                  </section>

                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">INFRASTRUCTURE</div>
                    </div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <div className="muted">Primary Node</div>
                      <div className="ok" style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 800 }}>ONLINE</div>
                    </div>
                    <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.06)", marginTop: 10, overflow: "hidden" }}>
                      <div style={{ width: "78%", height: "100%", background: "rgba(59,130,246,0.9)" }} />
                    </div>
                    <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
                      <div className="muted">Inference Load</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>12.4%</div>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          ) : null}

          {activeView === "agents" ? (
            <div style={{ padding: "0 22px 22px" }}>
              {runBanner ? (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="cardTitle">
                    <div className="cardTitleText">PROJECT</div>
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{runBanner.title}</div>
                    {idea?.trim() ? (
                      <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                        Project: {idea.trim()}
                      </div>
                    ) : null}
                    {runBanner.subtitle ? <div className="muted">{runBanner.subtitle}</div> : null}
                  </div>
                </div>
              ) : (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="cardTitle">
                    <div className="cardTitleText">PROJECT</div>
                  </div>
                  <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                    Project: {idea?.trim() ? idea.trim() : "(no idea provided)"}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div className="pageTitle">Agent Chat</div>
                  <p className="pageSubtitle">Run BMAD agents and skills on your product idea.</p>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="chip">
                    <span className={currentRunId ? "ok" : "muted"}>●</span>
                    <span>{currentRunId ? `Session: ${currentRunId}` : "No session"}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
                {/* Left: Agents */}
                <section className="card" style={{ position: "sticky", top: 16, alignSelf: "start" }}>
                  <div className="cardTitle">
                    <div className="cardTitleText">ACTIVE AGENTS</div>
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    {BMAD_METHOD_AGENTS.map((a) => {
                      const isActive = bmadAgentSkillId === a.id;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={"btnSecondary"}
                          onClick={() => setBmadAgentSkillId(a.id)}
                          style={{
                            textAlign: "left",
                            padding: "12px 12px",
                            border: isActive ? "1px solid rgba(59,130,246,0.85)" : undefined
                          }}
                          disabled={!canOpenAgentChat}
                        >
                          <div style={{ fontWeight: 800 }}>{a.label}{a.title ? ` (${a.title})` : ""}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{isActive ? "Selected" : "Click to select"}</div>
                        </button>
                      );
                    })}

                    <div className="row" style={{ justifyContent: "flex-end", marginTop: 6, gap: 10, flexWrap: "wrap" }}>
                      <button
                        className="btnRun"
                        type="button"
                        onClick={() => startBmadAgent().catch((e) => setBmadStatus(e?.message || "Failed"))}
                        disabled={!canOpenAgentChat}
                        title={!canOpenAgentChat ? "Fill product idea, test+save key, then run execution to create a session." : "Start BMAD agent"}
                      >
                        START AGENT
                      </button>
                    </div>

                    {!canOpenAgentChat ? (
                      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                        To enable Agent Chat: enter a Product idea, TEST KEY, SAVE KEY, then run BMAD execution.
                      </div>
                    ) : null}
                  </div>
                </section>

                {/* Right: Chat + Logs */}
                <div style={{ display: "grid", gap: 16 }}>
                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">BMAD CHAT INTERFACE</div>
                      <div className="muted" style={{ fontSize: 12, textAlign: "right" }}>
                        {bmadSession?.step?.kind === "bmad_steps" ? (
                          <>
                            {(bmadSession.activeSkillId || "") + " "}
                            step {bmadSession.step.index}/{bmadSession.step.total ?? "?"}
                            {bmadStatus ? ` • ${bmadStatus}` : ""}
                          </>
                        ) : (
                          bmadStatus || ""
                        )}
                      </div>
                    </div>

                    <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                      {stage !== "Idle" ? (
                        <>
                          Status: <span style={{ fontFamily: "var(--mono)", fontWeight: 800 }}>{stage}</span>
                          {stageDetail ? <span style={{ fontFamily: "var(--mono)" }}> • {stageDetail}</span> : null}
                        </>
                      ) : (
                        <>Status: <span style={{ fontFamily: "var(--mono)" }}>Ready</span></>
                      )}
                    </div>

                    {bmadErrorBanner ? (
                      <div className="err" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                        {bmadErrorBanner}
                      </div>
                    ) : null}

                    <div className="monoBox" style={{ minHeight: 520, maxHeight: 640, overflow: "auto" }} ref={bmadChatRef as any}>
                      {(bmadSession?.messages?.length
                        ? bmadSession.messages
                            .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}  ${new Date(m.ts).toLocaleTimeString()}\n${m.text}`)
                            .join("\n\n")
                        : "(start an agent to begin chatting)")}
                    </div>

                    {bmadMenu?.length ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {bmadMenu.slice(0, 14).map((it) => (
                          <button
                            key={it.code}
                            className="btnSecondary"
                            type="button"
                            onClick={() => {
                              if (it.skill) selectBmadSkill(it.skill).catch(() => {});
                              if (it.prompt) sendBmadChat(it.prompt).catch(() => {});
                            }}
                            disabled={!bmadSession || bmadBusy}
                            title={it.description ? String(it.description).split("\n")[0] : it.code}
                          >
                            {it.code}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    <div className="row" style={{ marginTop: 12, gap: 10 }}>
                      <input
                        className="input"
                        value={bmadChatInput}
                        onChange={(e) => setBmadChatInput(e.target.value)}
                        placeholder="Direct agent command…"
                        disabled={!bmadSession || bmadBusy}
                      />
                      <button className="btnRun" type="button" onClick={() => sendBmadChat().catch((e) => setBmadStatus(e?.message || "Failed"))} disabled={!bmadSession || bmadBusy}>
                        SEND
                      </button>
                    </div>
                  </section>

                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">LIVE OUTPUT</div>
                      <div className="muted" style={{ fontSize: 12 }}>execution logs</div>
                    </div>
                    <div className="monoBox" style={{ maxHeight: 320, overflow: "auto" }}>
                      {logs.length ? logs.join("\n") : "(logs will appear here)"}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          ) : activeView === "export" ? (
            <div className="cards2">
              <section className="card">
                <div className="cardTitle">
                  <div className="cardTitleText">Export Documents</div>
                  <div className="muted" style={{ fontSize: 12 }}>download markdown / pdf</div>
                </div>

                <div className="monoBox" style={{ minHeight: 260, maxHeight: 420, overflow: "auto" }}>
                  {(prdMd || analysisMd || output || "(no document yet — run an agent to generate artifacts)")}
                </div>
              </section>

              <section className="card">
                <div className="cardTitle">
                  <div className="cardTitleText">Download</div>
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <button
                    className="btnPrimary"
                    type="button"
                    disabled={!prdMd && !analysisMd && !output}
                    onClick={() => {
                      const content = prdMd || analysisMd || output || "";
                      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = prdMd ? "prd.md" : analysisMd ? "analysis.md" : "bmadly-output.md";
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download .md
                  </button>

                  <button
                    className="btnSecondary"
                    type="button"
                    disabled={!prdMd && !analysisMd && !output}
                    onClick={async () => {
                      const markdown = prdMd || analysisMd || output || "";
                      const title = prdMd ? "prd" : analysisMd ? "analysis" : "bmadly-output";
                      const r = await fetch(`${API_BASE_URL}/api/export/pdf`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ markdown, title })
                      });
                      if (!r.ok) {
                        const j = await r.json().catch(() => ({}));
                        throw new Error(j?.error || `PDF export failed (${r.status})`);
                      }
                      const blob = await r.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${title}.pdf`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download .pdf
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
