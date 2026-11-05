export const PLAYER_IDS = ['max', 'szymon'];
export const INITIAL = { max: 500, szymon: 1100 };
export const number = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value || 0);
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const duration = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(x => String(x).padStart(2, '0')).join(':');
};
export const secondsSince = date => Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
export function integer(value, minimum = 0, maximum = 1000000) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const text = String(raw ?? '');
  if (text === '' || !/^-?[0-9]+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < minimum || Number(text) > maximum) throw new Error(`Bitte eine ganze Zahl zwischen ${number(minimum)} und ${number(maximum)} eingeben.`);
  return Number(text);
}
export function dropProbability(p, n) {
  if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isSafeInteger(n) || n < 0) throw new Error('Ungültige Wahrscheinlichkeit oder Truhenzahl.');
  if (n === 0 || p === 0) return 0;
  if (p === 1) return 1;
  return -Math.expm1(n * Math.log1p(-p));
}
export function requiredChests(p, target) {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('Ungültige Wahrscheinlichkeit.');
  if (!Number.isFinite(target) || target < 0 || target > 1) throw new Error('Die Zielwahrscheinlichkeit muss zwischen 0 und 1 liegen.');
  if (p <= 0) return Infinity;
  if (p >= 1) return 1;
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  return Math.ceil(Math.log1p(-target) / Math.log1p(-p));
}
export function nextMilestone(total) {
  return [1000, 2500, 5000, 10000, 25000, 50000, 100000].find(x => x > total) || Math.ceil((total + 1) / 100000) * 100000;
}
export const activeSession = state => state.sessions.find(s => !s.ended_at);
export const activeRound = state => state.rounds.find(r => !r.ended_at);
export const roundCount = (state, roundId, playerId) => state.counts.find(c => c.round_id === roundId && c.player_id === playerId);
export const totalChests = state => state.players.reduce((sum, p) => sum + Number(p.total), 0);
export function roundTotal(state, roundId) {
  return state.counts.filter(c => c.round_id === roundId).reduce((sum, c) => sum + c.chests, 0);
}
export function roundSeconds(state, round, playerId) {
  const override = playerId && roundCount(state, round.id, playerId)?.duration_seconds;
  if (!playerId) {
    const durations = state.counts.filter(c => c.round_id === round.id && c.duration_seconds != null).map(c => c.duration_seconds);
    if (durations.length) return Math.max(...durations);
  }
  return override ?? Math.max(0, ((round.ended_at ? new Date(round.ended_at).getTime() : Date.now()) - new Date(round.started_at).getTime()) / 1000);
}
export function freshDemo() {
  return { players: PLAYER_IDS.map(id => ({ id, name: id === 'max' ? 'Max' : 'Szymon', initial_chests: INITIAL[id], total: INITIAL[id] })), sessions: [], rounds: [], counts: [], changes: [], daily: [], requests: {} };
}

// Pure demo engine: mirrors server rules. No fake rounds or invented activity.
export function applyDemo(state, request, actor, now = new Date().toISOString()) {
  const { id, action, payload: p } = request;
  const prior = state.requests[id];
  if (prior) {
    if (prior.actor !== actor || prior.action !== action || JSON.stringify(prior.payload) !== JSON.stringify(p)) throw new Error('Kennung bereits für eine andere Änderung verwendet.');
    return state;
  }
  if (!PLAYER_IDS.includes(actor)) throw new Error('Kein Spielerzugang.');
  const s = structuredClone(state);
  const own = () => { if (p.player_id !== actor) throw new Error('Du kannst nur deinen eigenen Counter ändern.'); };
  const add = (delta, roundId, reason, reversalOf = null) => {
    const player = s.players.find(x => x.id === actor);
    if (player.total + delta < player.initial_chests) throw new Error('Die Startwerte können nicht unterschritten werden.');
    player.total += delta;
    s.changes.unshift({ id, request_id: id, player_id: actor, actor_id: actor, round_id: roundId, round_revision: roundId ? roundCount(s,roundId,actor)?.revision : null, delta, reason, reversal_of: reversalOf, created_at: now });
    const day = now.slice(0, 10);
    let row = s.daily.find(x => x.day === day && x.player_id === actor);
    if (!row) { row = { day, player_id: actor, chests: 0 }; s.daily.push(row); }
    row.chests += delta;
  };
  const getRound = () => { const round = s.rounds.find(x => x.id === p.round_id); if (!round) throw new Error('Runde nicht gefunden.'); return round; };
  const checkCount = count => {
    if (count.revision !== p.expected_revision || count.chests !== p.expected_chests) throw new Error('Die Runde wurde inzwischen geändert. Bitte neu laden und den Eintrag prüfen.');
  };
  if (action === 'increment') {
    own(); const delta = integer(p.delta, 1, 10);
    if (![1, 5, 10].includes(delta)) throw new Error('Nur +1, +5 oder +10 erlaubt.');
    if (!p.round_id && activeSession(s)) throw new Error('Bitte zuerst eine Runde in der laufenden Session starten.');
    if (p.round_id) {
      const r = getRound(); const c = roundCount(s, r.id, actor);
      if (r.ended_at || c.revision !== p.expected_revision) throw new Error('Runde bereits abgeschlossen oder korrigiert. Bitte den Eintrag prüfen.');
      if (c.chests + delta > 1000000) throw new Error('Rundenlimit erreicht.');
      c.chests += delta;
    }
    add(delta, p.round_id || null, 'live');
  } else if (action === 'undo') {
    own(); const change = s.changes.find(x => x.id === p.change_id && x.player_id === actor && x.reason === 'live' && x.delta > 0);
    if (!change || s.changes.some(x => x.reversal_of === change.id)) throw new Error('Dieser Klick wurde bereits zurückgenommen.');
    if (change.round_id) {
      const c = roundCount(s, change.round_id, actor); const r = s.rounds.find(x => x.id === change.round_id);
      if (r.ended_at || c.revision !== change.round_revision || c.revision !== p.expected_revision || c.chests < change.delta) throw new Error('Bitte diese abgeschlossene oder korrigierte Runde über das Rundenbuch bearbeiten.');
      c.chests -= change.delta;
    }
    add(-change.delta, change.round_id, 'undo', change.id);
  } else if (action === 'start_session') {
    if (activeSession(s)) throw new Error('Es läuft bereits eine Session.');
    if (String(p.route || '').length > 160) throw new Error('Die Route darf höchstens 160 Zeichen lang sein.');
    s.sessions.unshift({ id: p.session_id, route: p.route || '', started_at: now, ended_at: null, created_by: actor });
  } else if (action === 'end_session') {
    const session = s.sessions.find(x => x.id === p.session_id && !x.ended_at);
    if (!session) throw new Error('Session bereits beendet.');
    if (activeRound(s)) throw new Error('Bitte zuerst die laufende Runde abschließen.');
    session.ended_at = now;
  } else if (action === 'start_round' || action === 'manual_round') {
    const session = s.sessions.find(x => x.id === p.session_id && !x.ended_at);
    if (!session) throw new Error('Bitte zuerst eine Session starten.');
    if (activeRound(s)) throw new Error('Es läuft bereits eine Runde. Nutze dort den endgültigen Gesamtwert.');
    const manual = action === 'manual_round';
    if (manual) own();
    const mins = manual && p.duration_seconds != null ? integer(p.duration_seconds, 1, 86400) : null;
    s.rounds.unshift({ id: p.round_id, session_id: session.id, started_at: mins ? new Date(Date.parse(now) - mins * 1000).toISOString() : now, ended_at: manual ? now : null, manual });
    for (const playerId of PLAYER_IDS) s.counts.push({ round_id: p.round_id, player_id: playerId, chests: manual && playerId === actor ? integer(p.total) : 0, revision: 0, duration_seconds: manual && playerId === actor ? mins : null });
    if (manual) add(integer(p.total), p.round_id, 'manual');
  } else if (action === 'set_round_total') {
    own(); const r = getRound(); const c = roundCount(s, r.id, actor); checkCount(c);
    const target = integer(p.total); const delta = target - c.chests;
    c.chests = target; c.revision++;
    c.duration_seconds = p.duration_seconds == null ? null : integer(p.duration_seconds, 1, 86400);
    add(delta, r.id, 'correction');
  } else if (action === 'end_round') {
    const r = getRound();
    if (r.ended_at) throw new Error('Runde bereits abgeschlossen.');
    const max = roundCount(s, r.id, 'max'), szymon = roundCount(s, r.id, 'szymon');
    if (max.chests !== p.expected_max || szymon.chests !== p.expected_szymon || max.revision !== p.revision_max || szymon.revision !== p.revision_szymon) throw new Error('Neue Truhen eingegangen. Bitte die Runde erneut prüfen.');
    r.ended_at = now;
  } else throw new Error('Unbekannte Aktion.');
  s.requests[id] = { actor, action, payload: p };
  return s;
}
