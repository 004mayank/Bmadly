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

export default function HomePage() {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  // Default to BYOK for best UX.
  // Note: BMAD Chat currently requires BYOK.
  const [useOwnKey, setUseOwnKey] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [idea, setIdea] = useState("");

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
  const [bmadAgentSkillId, setBmadAgentSkillId] = useState<string>("bmad-agent-analyst");
  const [bmadDebugOpen, setBmadDebugOpen] = useState(false);
  const [bmadDebugJson, setBmadDebugJson] = useState<string>("");

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const bmadChatRef = useRef<HTMLDivElement | null>(null);

  const providerConfig = useMemo(() => PROVIDERS.find((p) => p.id === provider)!, [provider]);

  useEffect(() => {
    // reset model to first for provider when provider changes
    setModel(providerConfig.models[0]);
  }, [providerConfig]);

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

    setBmadStatus("Starting agent…");
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: s.id,
        agentSkillId: bmadAgentSkillId,
        provider,
        model,
        apiKey
      })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j?.error || `Failed to start agent (${resp.status})`);
    }
    const j = await resp.json();
    setBmadMenu(j.menu as BmadMenuItem[]);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    setBmadStatus("Agent started");
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
    if (!resp.ok) throw new Error(j?.error || `BMAD message failed (${resp.status})`);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    if (bmadDebugOpen) {
      fetchBmadDebug((j.session as BmadSession).id).catch(() => {});
    }
    setBmadStatus("Ready");
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

    if (!provider || !model) {
      setRunState({ status: "error", message: "Select provider and model." });
      return;
    }

    if (!idea.trim()) {
      setRunState({ status: "error", message: "Enter a product idea." });
      return;
    }

    if (useOwnKey && apiKey.trim().length < 8) {
      setRunState({ status: "error", message: "BYOK is enabled but API key is missing." });
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

      // One-time runtime auth handshake (stores BYOK in the per-run container memory).
      if (useOwnKey) {
        setLogs((l) => [...l, "[ui] authenticating runtime…"]);
        const ar = await fetch(`${API_BASE_URL}/api/runtime/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: data.runId, provider, model, apiKey })
        });
        const aj = await ar.json().catch(() => ({}));
        if (!ar.ok) {
          setLogs((l) => [...l, `[ui] runtime auth failed: ${aj?.error || ar.status}`]);
        } else {
          setLogs((l) => [...l, "[ui] runtime authenticated"]);
        }
      }

      streamLogs(data.runId);
    } catch (e: any) {
      setStartedAt(null);
      setRunState({ status: "error", message: e?.message || "Failed to start run" });
    }
  }

  async function streamLogs(runId: string) {
    const es = new EventSource(`${API_BASE_URL}/api/run/${runId}/stream`);

    es.addEventListener("log", (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data);
      setLogs((prev) => [...prev, msg.line]);
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
    });

    es.onerror = () => {
      es.close();
      setStartedAt(null);
      setRunState({ status: "error", message: "Stream disconnected." });
    };
  }

  const isRunning = runState.status === "running";
  const currentRunId =
    runState.status === "running"
      ? runState.runId
      : runState.status === "done"
        ? runState.runId
        : null;

  const elapsedLabel = useMemo(() => {
    const s = elapsedSec;
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [elapsedSec]);

  return (
    <main className="container">
      <header style={{ marginBottom: 16 }}>
        <h1>Bmadly</h1>
        <p className="sub">browser-based BMAD execution</p>
      </header>

      <div className="appShell">
        <aside className="sidebar">
          <div className="sidebarTitle">BMADly</div>
          <button className={`navItem navItemActive`} type="button">
            <span>Environment</span>
            <span className="muted" style={{ fontSize: 12 }}>{isRunning ? "running" : "setup"}</span>
          </button>
          <button className={`navItem ${!currentRunId ? "navItemDisabled" : ""}`} type="button" disabled={!currentRunId}>
            <span>Agent Chat</span>
            <span className="muted" style={{ fontSize: 12 }}>{currentRunId ? "ready" : "locked"}</span>
          </button>
          <button className={`navItem ${!currentRunId ? "navItemDisabled" : ""}`} type="button" disabled={!currentRunId}>
            <span>Artifacts</span>
          </button>
          <button className={`navItem ${!currentRunId ? "navItemDisabled" : ""}`} type="button" disabled={!currentRunId}>
            <span>Logs</span>
          </button>
        </aside>

        <div>
          <div className="topTabs">
            <div className="tabsRow">
              <div className="tab tabActive">Execution</div>
              <div className="tab">Analytics</div>
              <div className="tab">Models</div>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {currentRunId && (
                <div className="badge" title={currentRunId}>
                  <span className="muted">runId</span>
                  <span style={{ fontSize: 12, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {currentRunId}
                  </span>
                </div>
              )}
              {isRunning && (
                <div className="badge">
                  <span className="muted">elapsed</span>
                  <span style={{ fontSize: 12 }}>{elapsedLabel}</span>
                </div>
              )}
              <button className="btnSecondary" type="button" onClick={clearPanels} disabled={isRunning}>
                Clear
              </button>
            </div>
          </div>

          <div className="cards2">
            <section className="card">
              <div className="cardTitle">
                <div className="cardTitleText">Environment Setup</div>
                <div className="pill">
                  <span className={isRunning ? "ok" : "muted"}>●</span>
                  <span className="muted" style={{ fontSize: 12 }}>{isRunning ? "Running" : "Ready"}</span>
                </div>
              </div>

          <div className="split2">
            <div>
              <label className="label">LLM Provider</label>
              <select
                className="select"
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderId)}
                disabled={isRunning}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Model</label>
              <select
                className="select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isRunning}
              >
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

          <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <label className="pill" style={{ cursor: isRunning ? "not-allowed" : "pointer" }}>
              <input
                type="checkbox"
                checked={useOwnKey}
                disabled={true}
                onChange={() => {}}
                style={{ marginRight: 8 }}
              />
              API key (required)
            </label>
          </div>

          {useOwnKey && (
            <>
              <label className="label">API Key</label>
              <input
                className="input"
                type="password"
                value={apiKey}
                disabled={isRunning}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
              />
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Key is used to call the selected LLM provider and is not stored.
              </div>
            </>
          )}

          <button className="btnPrimary" onClick={startRun} disabled={isRunning}>
            {isRunning ? "Running…" : "Run BMAD"}
          </button>

          {runState.status === "error" && <div className="err" style={{ marginTop: 10 }}>{runState.message}</div>}
          {runState.status === "done" && (
            <div style={{ marginTop: 10 }} className={runState.finalStatus === "succeeded" ? "ok" : "err"}>
              {runState.finalStatus.toUpperCase()}
            </div>
          )}

          {runState.status !== "running" && currentRunId && (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                Iterate (scoped)
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button
                  className="btnSecondary"
                  type="button"
                  onClick={async () => {
                    setLogs([]);
                    setStartedAt(Date.now());
                    setElapsedSec(0);
                    setRunState({ status: "running", runId: currentRunId });
                    await fetch(`${API_BASE_URL}/api/pipeline/iterate`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        runId: currentRunId,
                        intent: "improve_ui",
                        provider,
                        model,
                        // Runtime backend uses one-time /api/runtime/auth.
                        // Keep these fields for backward compatibility but do not resend apiKey.
                        useOwnKey,
                        apiKey: undefined
                      })
                    });
                    streamLogs(currentRunId);
                  }}
                >
                  Improve UI
                </button>
                <button
                  className="btnSecondary"
                  type="button"
                  onClick={async () => {
                    setLogs([]);
                    setStartedAt(Date.now());
                    setElapsedSec(0);
                    setRunState({ status: "running", runId: currentRunId });
                    await fetch(`${API_BASE_URL}/api/pipeline/iterate`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        runId: currentRunId,
                        intent: "fix_bugs",
                        provider,
                        model,
                        useOwnKey,
                        apiKey: undefined
                      })
                    });
                    streamLogs(currentRunId);
                  }}
                >
                  Fix bugs
                </button>
                <button
                  className="btnSecondary"
                  type="button"
                  onClick={async () => {
                    const note = prompt("Feature to add?") || "";
                    if (!note.trim()) return;
                    setLogs([]);
                    setStartedAt(Date.now());
                    setElapsedSec(0);
                    setRunState({ status: "running", runId: currentRunId });
                    await fetch(`${API_BASE_URL}/api/pipeline/iterate`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        runId: currentRunId,
                        intent: "add_feature",
                        note,
                        provider,
                        model,
                        useOwnKey,
                        apiKey: undefined
                      })
                    });
                    streamLogs(currentRunId);
                  }}
                >
                  Add feature
                </button>
              </div>
            </div>
          )}
            </section>

            <section className="card">
              <div className="cardTitle">
                <div className="cardTitleText">Stdout Monitor</div>
                <div className="muted" style={{ fontSize: 12 }}>runtime + execution logs</div>
              </div>
              <div className="monoBox" style={{ maxHeight: 380, overflow: "auto" }}>
                {logs.length ? logs.join("\n") : "(logs will appear here)"}
              </div>
            </section>
          </div>

          <section className="panel" style={{ marginTop: 16 }}>
            <div style={{ display: "grid", gap: 12 }}>
            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">BMAD Chat</div>
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

              <div className="output" style={{ display: "grid", gap: 10 }}>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <select
                    className="select"
                    value={bmadAgentSkillId}
                    onChange={(e) => setBmadAgentSkillId(e.target.value)}
                    disabled={!currentRunId}
                    title="BMAD agent skill id"
                  >
                    <option value="bmad-agent-analyst">Mary (Analyst)</option>
                    <option value="bmad-agent-pm">PM</option>
                    <option value="bmad-agent-ux-designer">UX Designer</option>
                    <option value="bmad-agent-architect">Architect</option>
                    <option value="bmad-agent-dev">Dev</option>
                    <option value="bmad-agent-tech-writer">Tech Writer</option>
                  </select>

                  <button className="btnSecondary" type="button" onClick={() => startBmadAgent().catch((e) => setBmadStatus(e?.message || "Failed"))}>
                    Start agent
                  </button>

                  <button
                    className="btnSecondary"
                    type="button"
                    disabled={!bmadSession}
                    onClick={() => {
                      const next = !bmadDebugOpen;
                      setBmadDebugOpen(next);
                      if (next && bmadSession) {
                        fetchBmadDebug(bmadSession.id).catch((e) => setBmadStatus(e?.message || "Debug failed"));
                      }
                    }}
                  >
                    {bmadDebugOpen ? "Hide debug" : "Debug"}
                  </button>

                  <button
                    className="btnSecondary"
                    type="button"
                    disabled={!currentRunId}
                    onClick={() => {
                      setBmadSession(null);
                      setBmadMenu(null);
                      setBmadStatus("Reset. Click Start agent to begin a new session.");
                    }}
                    title="Reset local BMAD chat state (new session will be created on next start)"
                  >
                    Reset
                  </button>
                </div>

                {bmadDebugOpen && bmadDebugJson ? (
                  <div className="output" style={{ maxHeight: 200, overflow: "auto" }}>
                    {bmadDebugJson}
                  </div>
                ) : null}

                {bmadMenu && bmadMenu.length > 0 && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Menu
                    </div>
                    <div className="row" style={{ flexWrap: "wrap" }}>
                      {bmadMenu.map((m) => (
                        <button
                          key={m.code}
                          className="btnSecondary"
                          type="button"
                          onClick={() => {
                            if (m.skill) selectBmadSkill(m.skill).catch((e) => setBmadStatus(e?.message || "Failed"));
                          }}
                          title={m.skill || m.prompt || ""}
                        >
                          {m.code}: {m.description}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div ref={bmadChatRef} style={{ maxHeight: 220, overflow: "auto", border: "1px solid #1f2937", borderRadius: 14, padding: 12, background: "#0b1020" }}>
                  {!bmadSession || bmadSession.messages.length === 0 ? (
                    <div className="terminalLineDim">(start an agent to begin chatting)</div>
                  ) : (
                    bmadSession.messages.map((m, idx) => (
                      <div key={idx} className={m.role === "assistant" ? "terminalLine" : "terminalLineWarn"}>
                        <span style={{ opacity: 0.7 }}>{m.role === "assistant" ? "assistant" : "you"}:</span> {m.text}
                      </div>
                    ))
                  )}
                </div>

                <div className="row">
                  <input
                    className="input"
                    value={bmadChatInput}
                    onChange={(e) => setBmadChatInput(e.target.value)}
                    placeholder="Type your reply…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendBmadChat().catch((err) => setBmadStatus(err?.message || "Failed"));
                      }
                    }}
                  />
                  <button
                    className="btnSecondary"
                    type="button"
                    disabled={bmadSession?.step?.kind !== "bmad_steps"}
                    onClick={() => {
                      sendBmadChat("C").catch((e) => setBmadStatus(e?.message || "Failed"));
                    }}
                    title="BMAD continue"
                  >
                    Continue
                  </button>
                  <button
                    className="btnSecondary"
                    type="button"
                    disabled={bmadSession?.step?.kind !== "bmad_steps"}
                    onClick={() => {
                      sendBmadChat("Modify").catch((e) => setBmadStatus(e?.message || "Failed"));
                    }}
                    title="BMAD modify scope"
                  >
                    Modify
                  </button>
                  <button className="btnPrimary" type="button" onClick={() => sendBmadChat().catch((e) => setBmadStatus(e?.message || "Failed"))}>
                    Send
                  </button>
                </div>

                {bmadSession?.artifacts?.length ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Artifacts
                    </div>
                    {bmadSession.artifacts.map((a) => (
                      <div key={a.id} style={{ border: "1px solid #1f2937", borderRadius: 12, padding: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ fontSize: 12, opacity: 0.8 }}>{a.type}{a.title ? ` — ${a.title}` : ""}</div>
                          <button
                            className="btnSecondary"
                            type="button"
                            onClick={() => navigator.clipboard.writeText(a.content).catch(() => {})}
                          >
                            Copy
                          </button>
                        </div>
                        <div className="output" style={{ marginTop: 8 }}>{a.content}</div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {bmadSession?.step?.kind === "bmad_steps" ? (
                  (() => {
                    // Prefer backend-provided canonical pointer for the current document.
                    // Fallback: best-effort based on known doc types (for older sessions).
                    const knownDocTypes = [
                      "prd",
                      "prd-review",
                      "epics-and-stories",
                      "implementation-readiness",
                      "market-research",
                      "domain-research",
                      "technical-research"
                    ];

                    const doc = bmadSession.primaryArtifactId
                      ? bmadSession.artifacts.find((a) => a.id === bmadSession.primaryArtifactId)
                      : bmadSession.artifacts.find((a) => knownDocTypes.includes(a.type));
                    if (!doc) return null;

                    const filename = `${doc.type}.md`;
                    const download = () => {
                      const blob = new Blob([doc.content], { type: "text/markdown;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = filename;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    };

                    return (
                      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                        <div className="muted" style={{ fontSize: 12 }}>
                          Current Document ({doc.type})
                        </div>
                        <div style={{ border: "1px solid #1f2937", borderRadius: 12, padding: 10 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ fontSize: 12, opacity: 0.8 }}>{doc.title || "market-research"}</div>
                            <div className="row" style={{ gap: 8 }}>
                              <button
                                className="btnSecondary"
                                type="button"
                                onClick={() => navigator.clipboard.writeText(doc.content).catch(() => {})}
                              >
                                Copy
                              </button>
                              <button className="btnSecondary" type="button" onClick={download}>
                                Download
                              </button>
                            </div>
                          </div>
                          <div className="output" style={{ marginTop: 8, maxHeight: 260, overflow: "auto" }}>
                            {doc.content}
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : null}

                {bmadArtifactsFromRun.length ? (
                  <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      BMAD Artifacts (attached to run)
                    </div>
                    {bmadArtifactsFromRun.map((a) => (
                      <div key={a.id} style={{ border: "1px solid #1f2937", borderRadius: 12, padding: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ fontSize: 12, opacity: 0.8 }}>
                            {a.type}
                            {a.title ? ` — ${a.title}` : ""}
                          </div>
                          <button
                            className="btnSecondary"
                            type="button"
                            onClick={() => navigator.clipboard.writeText(a.content).catch(() => {})}
                          >
                            Copy
                          </button>
                        </div>
                        <div className="output" style={{ marginTop: 8 }}>
                          {a.content}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Analysis</div>
                {analysisMd && (
                  <button className="btnSecondary" onClick={() => navigator.clipboard.writeText(analysisMd).catch(() => {})} type="button">
                    Copy
                  </button>
                )}
              </div>
              <div className="output">{analysisMd ? analysisMd : <span className="muted">(analysis will appear here)</span>}</div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">PRD</div>
                {prdMd && (
                  <button className="btnSecondary" onClick={() => navigator.clipboard.writeText(prdMd).catch(() => {})} type="button">
                    Copy
                  </button>
                )}
              </div>
              <div className="output">{prdMd ? prdMd : <span className="muted">(PRD will appear here)</span>}</div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Plan</div>
                {planJson && (
                  <button
                    className="btnSecondary"
                    onClick={() => navigator.clipboard.writeText(planJson).catch(() => {})}
                    type="button"
                  >
                    Copy
                  </button>
                )}
              </div>
              <div className="output">
                {planJson ? planJson : <span className="muted">(plan will appear here)</span>}
              </div>
            </div>

            <div>
              <div className="terminalHeader">
                <div className="muted">Logs</div>
                {runState.status === "running" && (
                  <div className="pill">
                    <span className="muted">streaming</span>
                    <span className="ok">●</span>
                  </div>
                )}
              </div>
              <div className="terminal" ref={terminalRef}>
                {logs.length === 0 ? (
                  <span className="terminalLineDim">(logs will appear here)</span>
                ) : (
                  logs.map((line, idx) => {
                    const cls =
                      /\b(error|failed|fatal)\b/i.test(line)
                        ? "terminalLineErr"
                        : /\b(warn|warning)\b/i.test(line)
                          ? "terminalLineWarn"
                          : "terminalLine";
                    return (
                      <div key={idx} className={cls}>
                        {line}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Preview</div>
              </div>
              <div className="output" style={{ padding: 0, overflow: "hidden" }}>
                {runState.status === "running" && !previewUrl ? (
                  <div style={{ padding: 14 }} className="muted">
                    Starting preview…
                  </div>
                ) : previewUrl ? (
                  <iframe
                    src={previewUrl}
                    style={{ width: "100%", height: 320, border: 0, borderRadius: 16 }}
                    title="preview"
                  />
                ) : (
                  <div style={{ padding: 14 }} className="muted">
                    (preview will appear here)
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Review</div>
                {reviewText && (
                  <button
                    className="btnSecondary"
                    onClick={() => navigator.clipboard.writeText(reviewText).catch(() => {})}
                    type="button"
                  >
                    Copy
                  </button>
                )}
              </div>
              <div className="output">
                {reviewText ? reviewText : <span className="muted">(review will appear here)</span>}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Raw result</div>
                {output && (
                  <button
                    className="btnSecondary"
                    onClick={() => {
                      navigator.clipboard.writeText(output).catch(() => {});
                    }}
                    type="button"
                  >
                    Copy
                  </button>
                )}
              </div>
              <div className="output">
                {output ? output : <span className="muted">(final output will appear here)</span>}
              </div>
            </div>
          </div>
          </section>
        </div>
      </div>
    </main>
  );
}
