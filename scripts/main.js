const MODULE_ID = "dnd-table-webhooks";

let socket = null;
let reconnectTimer = null;
let isSocketAuthenticated = false;
let lastNextTurnAt = 0;

function log(...args) {
  console.log(`[${MODULE_ID}]`, ...args);
}

function warn(...args) {
  console.warn(`[${MODULE_ID}]`, ...args);
}

function error(...args) {
  console.error(`[${MODULE_ID}]`, ...args);
}

function debug(...args) {
  if (getSetting("debug")) {
    console.log(`[${MODULE_ID}]`, ...args);
  }
}

function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

function getWsUrl() {
  return getSetting("wsUrl")?.trim();
}

function getSharedSecret() {
  return getSetting("sharedSecret")?.trim();
}

function isEnabled() {
  return getSetting("enabled") === true;
}

function canOperate() {
  return game.user?.isGM && isEnabled() && !!getSharedSecret();
}

function registerSettings() {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable integration",
    hint: "Enables combat event sync with the local smart table application.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "wsUrl", {
    name: "WebSocket URL",
    hint: "Local application WebSocket endpoint. Example: ws://localhost:30000/foundry",
    scope: "world",
    config: true,
    type: String,
    default: "ws://localhost:30000/foundry"
  });

  game.settings.register(MODULE_ID, "sharedSecret", {
    name: "Shared secret",
    hint: "Must match the local application secret. Connection is disabled if empty.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "Debug logs",
    hint: "Write verbose logs to the browser console.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
}

function getCombatantInfo(combat, turnIndex) {
  if (!combat) return null;
  if (!Number.isInteger(turnIndex) || turnIndex < 0) return null;

  const combatant = combat.turns?.[turnIndex] ?? null;
  if (!combatant) return null;

  return {
    combatantId: combatant.id ?? null,
    actorId: combatant.actor?.id ?? null,
    actorName: combatant.actor?.name ?? combatant.token?.name ?? combatant.name ?? null,
    tokenId: combatant.token?.id ?? combatant.tokenId ?? null,
    tokenName: combatant.token?.name ?? combatant.name ?? null,
    initiative: combatant.initiative ?? null,
    defeated: combatant.isDefeated ?? false,
    hidden: combatant.hidden ?? false
  };
}

function getCombatState(combat) {
  if (!combat) return null;

  return {
    combatId: combat.id ?? null,
    combatSceneId: combat.scene?.id ?? combat.sceneId ?? null,
    combatSceneName: combat.scene?.name ?? null,
    round: combat.round ?? null,
    turn: combat.turn ?? null,
    started: combat.started ?? false,
    activeCombatant: getCombatantInfo(combat, combat.turn)
  };
}

function sendMessage(message) {
  if (!canOperate()) return false;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (!isSocketAuthenticated) return false;

  try {
    socket.send(JSON.stringify(message));
    debug("WS sent:", message);
    return true;
  } catch (err) {
    error("WS send failed", err, message);
    return false;
  }
}

function sendEvent(eventName, payload = {}) {
  return sendMessage({
    type: "event",
    event: eventName,
    timestamp: new Date().toISOString(),
    world: {
      id: game.world?.id ?? null,
      title: game.world?.title ?? null
    },
    user: {
      id: game.user?.id ?? null,
      name: game.user?.name ?? null
    },
    payload
  });
}

function sendResult(requestId, command, ok, payload = null, errorObj = null) {
  return sendMessage({
    type: "result",
    requestId: requestId ?? null,
    command,
    ok,
    payload,
    error: errorObj
  });
}

async function handleCombatNextTurn(message) {
  const requestId = message?.requestId ?? null;
  const command = message?.command ?? "combat.nextTurn";

  if (!canOperate()) return;

  const now = Date.now();
  if (now - lastNextTurnAt < 500) {
    await sendResult(requestId, command, false, null, {
      code: "duplicate_command",
      message: "Command ignored because it arrived too soon after the previous one."
    });
    return;
  }
  lastNextTurnAt = now;

  const combat = game.combat;

  if (!combat) {
    await sendResult(requestId, command, false, null, {
      code: "no_active_combat",
      message: "No active combat exists."
    });
    return;
  }

  if (!combat.started) {
    await sendResult(requestId, command, false, null, {
      code: "combat_not_started",
      message: "Combat exists but has not started.",
      combat: getCombatState(combat)
    });
    return;
  }

  try {
    await combat.nextTurn();

    await sendResult(requestId, command, true, {
      source: message?.source ?? "local-app",
      combat: getCombatState(game.combat)
    });
  } catch (err) {
    await sendResult(requestId, command, false, null, {
      code: "next_turn_failed",
      message: String(err),
      combat: getCombatState(combat)
    });
  }
}

async function handleCommand(message) {
  const command = message?.command;

  switch (command) {
    case "combat.nextTurn":
      await handleCombatNextTurn(message);
      break;

    default:
      await sendResult(message?.requestId ?? null, command ?? null, false, null, {
        code: "unknown_command",
        message: `Unsupported command: ${command}`
      });
      break;
  }
}

async function handleSocketMessage(rawData) {
  let msg;

  try {
    msg = JSON.parse(rawData);
  } catch (err) {
    error("Invalid WS message", err, rawData);
    return;
  }

  if (!msg || typeof msg !== "object") return;

  if (msg.type === "auth.ok") {
    isSocketAuthenticated = true;
    log("WebSocket authenticated");
    return;
  }

  if (msg.type === "auth.error") {
    isSocketAuthenticated = false;
    error("Authentication rejected by local app:", msg.reason ?? "unknown_reason");
    return;
  }

  if (!isSocketAuthenticated) {
    warn("Ignoring WS message before authentication");
    return;
  }

  if (msg.type === "ping") {
    sendMessage({
      type: "pong",
      module: MODULE_ID,
      worldId: game.world?.id ?? null,
      userId: game.user?.id ?? null
    });
    return;
  }

  if (msg.type === "command") {
    await handleCommand(msg);
    return;
  }

  debug("Ignored WS message:", msg);
}

function cleanupSocket() {
  isSocketAuthenticated = false;

  if (socket) {
    try {
      socket.close();
    } catch (err) {
      debug("Socket close ignored", err);
    }
  }

  socket = null;
}

function scheduleReconnect() {
  if (!canOperate()) return;
  if (reconnectTimer) return;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

function connectWebSocket() {
  if (!canOperate()) {
    debug("WS connect skipped: disabled, no secret, or not GM");
    cleanupSocket();
    return;
  }

  const wsUrl = getWsUrl();
  const secret = getSharedSecret();

  if (!wsUrl) {
    warn("WebSocket URL is empty");
    return;
  }

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isSocketAuthenticated = false;

  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    error("WebSocket creation failed", err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    log("Connected to local app websocket");

    socket.send(JSON.stringify({
      type: "auth",
      role: "foundry-gm",
      module: MODULE_ID,
      secret,
      worldId: game.world?.id ?? null,
      worldTitle: game.world?.title ?? null,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    }));
  });

  socket.addEventListener("message", async (event) => {
    await handleSocketMessage(event.data);
  });

  socket.addEventListener("close", () => {
    warn("WebSocket closed");
    isSocketAuthenticated = false;
    scheduleReconnect();
  });

  socket.addEventListener("error", (err) => {
    error("WebSocket error", err);
  });
}

function refreshConnection() {
  cleanupSocket();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  connectWebSocket();
}

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  log("ready");

  if (game.user?.isGM) {
    connectWebSocket();
  }
});

Hooks.on("updateSetting", (setting) => {
  if (!game.user?.isGM) return;
  if (!setting?.key?.startsWith(`${MODULE_ID}.`)) return;

  const watchedKeys = new Set([
    `${MODULE_ID}.enabled`,
    `${MODULE_ID}.wsUrl`,
    `${MODULE_ID}.sharedSecret`
  ]);

  if (watchedKeys.has(setting.key)) {
    log("Settings changed, refreshing websocket connection");
    refreshConnection();
  }
});

Hooks.on("combatStart", (combat, updateData) => {
  const active = getCombatantInfo(combat, updateData?.turn ?? combat.turn);

  sendEvent("combat.started", {
    combatId: combat.id ?? null,
    combatSceneId: combat.scene?.id ?? combat.sceneId ?? null,
    combatSceneName: combat.scene?.name ?? null,
    round: updateData?.round ?? combat.round ?? null,
    turn: updateData?.turn ?? combat.turn ?? null,
    activeCombatant: active
  });
});

Hooks.on("combatTurnChange", (combat, prior, current) => {
  const previousCombatant = getCombatantInfo(combat, prior?.turn);
  const currentCombatant = getCombatantInfo(combat, current?.turn);

  sendEvent("combat.turnChanged", {
    combatId: combat.id ?? null,
    combatSceneId: combat.scene?.id ?? combat.sceneId ?? null,
    combatSceneName: combat.scene?.name ?? null,
    previous: {
      round: prior?.round ?? null,
      turn: prior?.turn ?? null,
      combatant: previousCombatant
    },
    current: {
      round: current?.round ?? null,
      turn: current?.turn ?? null,
      combatant: currentCombatant
    }
  });
});

Hooks.on("deleteCombat", (combat, options, userId) => {
  sendEvent("combat.ended", {
    combatId: combat.id ?? null,
    combatSceneId: combat.scene?.id ?? combat.sceneId ?? null,
    combatSceneName: combat.scene?.name ?? null,
    endedByUserId: userId ?? null,
    finalState: {
      round: combat.round ?? null,
      turn: combat.turn ?? null,
      activeCombatant: getCombatantInfo(combat, combat.turn)
    }
  });
});