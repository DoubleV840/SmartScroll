'use strict';

/* SmartScroll : un fil vertical de vidéos YouTube limité aux sujets choisis.
 *
 * Fonctionnement :
 *  - chaque sujet a une « réserve » de vidéos trouvées par l'API YouTube
 *    (search.list, puis videos.list pour la durée, le format et les tags) ;
 *  - le fil pioche à tour de rôle dans les réserves des sujets actifs ;
 *  - un seul lecteur YouTube, fixe, joue la vidéo de la diapo active. Le fil
 *    est posé par-dessus et capte tous les gestes (défilement, tapotements). */

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- Stockage local ----------

const STORE = 'smartscroll:';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(STORE + key, JSON.stringify(value));
  } catch {
    // Stockage plein ou bloqué (navigation privée) : l'appli marche quand même.
  }
}

const DEFAULTS = {
  apiKey: '',
  topics: [],        // [{ id, q, on }]
  exclude: [],       // mots à écarter
  format: 'shorts',  // 'shorts' | 'all'
  lang: 'fr',        // 'fr' | 'en' | ''
  period: '',        // 'month' | 'year' | ''
  order: 'relevance',
  autoNext: false,
  blocked: [],       // [{ id, title }] chaînes masquées
};

let settings = { ...DEFAULTS, ...load('settings', {}) };
let pools = load('pools', {});          // id du sujet -> réserve de vidéos
const seen = new Set(load('seen', []));
let favorites = load('favorites', []);  // vidéos complètes, plus récente en premier
let quota = load('quota', { day: '', used: 0 });
let filter = load('filter', 'all');     // 'all' | 'fav' | id d'un sujet

const saveSettings = () => save('settings', settings);
const savePools = () => save('pools', pools);
const saveSeen = () => save('seen', [...seen].slice(-5000));
const saveFavorites = () => save('favorites', favorites);

// ---------- Utilitaires ----------

const rid = () => Math.random().toString(36).slice(2, 10);

function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Le quota YouTube repart à zéro à minuit, heure du Pacifique (9 h en France).
const quotaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

function usedQuota() {
  return quota.day === quotaDay() ? quota.used : 0;
}

function addQuota(units) {
  const day = quotaDay();
  if (quota.day !== day) quota = { day, used: 0 };
  quota.used += units;
  save('quota', quota);
}

const normalize = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function excludedBy(text) {
  const t = normalize(text);
  return settings.exclude.find((w) => {
    const word = normalize(w).trim();
    return word && new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(t);
  });
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

function timeAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (!(days >= 0)) return '';
  if (days < 1) return "aujourd'hui";
  if (days < 7) return `il y a ${days} j`;
  if (days < 31) return `il y a ${Math.floor(days / 7)} sem.`;
  if (days < 365) return `il y a ${Math.floor(days / 30)} mois`;
  const years = Math.floor(days / 365);
  return `il y a ${years} an${years > 1 ? 's' : ''}`;
}

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const isBlocked = (channelId) => settings.blocked.some((c) => c.id === channelId);
const isFav = (id) => favorites.some((v) => v.id === id);
const topicById = (id) => settings.topics.find((t) => t.id === id);

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------- API YouTube ----------

const API = 'https://www.googleapis.com/youtube/v3/';

class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'key' | 'quota' | 'network' | 'page' | 'other'
  }
}

async function api(path, params, cost, key = settings.apiKey) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) url.searchParams.set(k, v);
  }
  url.searchParams.set('key', key);

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError('network', 'Pas de connexion internet.');
  }
  addQuota(cost);
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;

  const err = data.error || {};
  const reason = err.errors?.[0]?.reason || '';
  const all = `${reason} ${err.message || ''} ${JSON.stringify(err.details || '')}`;
  if (/quotaExceeded|dailyLimitExceeded/.test(all)) {
    quota = { day: quotaDay(), used: 10000 };
    save('quota', quota);
    throw new ApiError('quota', 'Le quota YouTube du jour est épuisé. Il repart à zéro vers 9 h.');
  }
  if (/REFERRER|referer/i.test(all)) {
    throw new ApiError('key', "Ta clé API n'autorise pas cette adresse. Vérifie la restriction « Sites web » de la clé.");
  }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/.test(all)) {
    throw new ApiError('key', "« YouTube Data API v3 » n'est pas activée dans ton projet Google Cloud (étape 2).");
  }
  if (/keyInvalid|API_KEY_INVALID|API key not valid|badRequest.*key/i.test(all)) {
    throw new ApiError('key', 'Cette clé API est invalide. Vérifie que tu as copié la clé en entier.');
  }
  if (/invalidPageToken/.test(all)) throw new ApiError('page', '');
  throw new ApiError('other', err.message || `Erreur YouTube (${res.status}).`);
}

function searchParams(topic, pageToken) {
  let q = topic.q;
  // Le mot-clé #shorts aide la recherche à remonter des vidéos verticales.
  if (settings.format === 'shorts') q += ' #shorts';
  for (const w of settings.exclude) q += w.includes(' ') ? ` -"${w}"` : ` -${w}`;

  const params = {
    part: 'snippet',
    type: 'video',
    maxResults: 50,
    q,
    order: settings.order,
    regionCode: 'FR', // seulement des vidéos visibles en France
    relevanceLanguage: settings.lang,
    safeSearch: 'moderate',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    pageToken,
  };
  if (settings.format === 'shorts') params.videoDuration = 'short';
  if (settings.period) {
    const d = new Date();
    if (settings.period === 'month') d.setMonth(d.getMonth() - 1);
    else d.setFullYear(d.getFullYear() - 1);
    params.publishedAfter = d.toISOString().replace(/\.\d+Z$/, 'Z');
  }
  return params;
}

// Transforme une réponse videos.list en vidéo du fil, ou null si elle ne
// passe pas les filtres.
function toVideo(item, topicId) {
  const sn = item.snippet || {};
  if (item.status?.embeddable === false) return null;
  if (sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none') return null;
  if (isBlocked(sn.channelId)) return null;

  const duration = parseDuration(item.contentDetails?.duration);
  if (!duration) return null;

  const w = +item.player?.embedWidth;
  const h = +item.player?.embedHeight;
  const vertical = w && h ? h > w : settings.format === 'shorts';
  if (settings.format === 'shorts' && (duration > 180 || !vertical)) return null;

  if (settings.lang) {
    const audio = (sn.defaultAudioLanguage || sn.defaultLanguage || '').toLowerCase();
    if (audio && !audio.startsWith(settings.lang)) return null;
  }

  const title = sn.localized?.title || sn.title || '';
  const text = [title, sn.title, sn.description, (sn.tags || []).join(' '), sn.channelTitle].join(' ');
  if (excludedBy(text)) return null;

  return {
    id: item.id,
    title,
    channel: sn.channelTitle || '',
    channelId: sn.channelId || '',
    published: sn.publishedAt || '',
    duration,
    views: +(item.statistics?.viewCount || 0),
    vertical,
    topic: topicId,
  };
}

// ---------- Réserves de vidéos par sujet ----------

// Toute modification d'un filtre de recherche invalide les réserves.
const searchSig = () =>
  JSON.stringify([settings.format, settings.lang, settings.period, settings.order, settings.exclude]);

function poolFor(topic) {
  let p = pools[topic.id];
  if (!p || p.sig !== searchSig() || p.q !== topic.q) {
    p = pools[topic.id] = { sig: searchSig(), q: topic.q, day: '', next: null, done: false, items: [] };
  }
  return p;
}

// Une réserve « épuisée » le reste jusqu'au lendemain : la recherche repart
// alors de la première page pour attraper les nouveautés.
const poolExhausted = (p) => p.done && p.day === localDay();

async function fetchTopic(topic) {
  const p = poolFor(topic);
  const restart = p.day !== localDay();
  if (!restart && p.done) return 0;

  let data;
  try {
    data = await api('search', searchParams(topic, restart ? '' : p.next), 100);
  } catch (e) {
    if (e.kind !== 'page') throw e;
    p.day = '';
    p.next = null;
    return 0;
  }
  p.day = localDay();
  p.next = data.nextPageToken || null;
  p.done = !p.next;

  const known = new Set(p.items.map((v) => v.id));
  const ids = (data.items || [])
    .map((it) => it.id?.videoId)
    .filter((id) => id && !seen.has(id) && !inFeed.has(id) && !known.has(id));

  let added = 0;
  if (ids.length) {
    const details = await api('videos', {
      part: 'snippet,contentDetails,statistics,status,player',
      id: ids.join(','),
      maxWidth: 720, // fait renvoyer embedWidth/embedHeight, donc le format
      hl: settings.lang || 'fr',
    }, 1);
    const rank = new Map(ids.map((id, i) => [id, i]));
    const videos = (details.items || [])
      .sort((a, b) => rank.get(a.id) - rank.get(b.id))
      .map((it) => toVideo(it, topic.id))
      .filter(Boolean);
    // Un léger mélange par paquets de 5 garde l'ordre de pertinence global.
    for (let i = 0; i < videos.length; i += 5) p.items.push(...shuffle(videos.slice(i, i + 5)));
    added = videos.length;
  }
  savePools();
  return added;
}

let drawTurn = 0;

// Pioche jusqu'à n vidéos en alternant strictement entre les sujets.
function draw(topics, n) {
  const out = [];
  let misses = 0;
  while (out.length < n && misses < topics.length) {
    const p = poolFor(topics[drawTurn++ % topics.length]);
    let v;
    while ((v = p.items.shift())) {
      if (!seen.has(v.id) && !inFeed.has(v.id) && !isBlocked(v.channelId)) break;
    }
    if (v) {
      out.push(v);
      misses = 0;
    } else {
      misses++;
    }
  }
  if (out.length) savePools();
  return out;
}

// Remet dans les réserves les vidéos du fil pas encore regardées, sauf si
// les filtres ont changé entre-temps (la réserve est alors périmée).
function returnToPools(videos) {
  for (const v of [...videos].reverse()) {
    const topic = topicById(v.topic);
    const p = topic && pools[topic.id];
    if (!p || p.sig !== searchSig() || p.q !== topic.q || seen.has(v.id)) continue;
    if (!p.items.some((x) => x.id === v.id)) p.items.unshift(v);
  }
  savePools();
}

const enabledTopics = () => settings.topics.filter((t) => t.on);

function currentTopics() {
  if (filter === 'all') return enabledTopics();
  const t = topicById(filter);
  return t ? [t] : [];
}

let fetchTurn = 0;

function nextTopicToFetch(topics) {
  for (let k = 0; k < topics.length; k++) {
    const t = topics[(fetchTurn + k) % topics.length];
    if (!poolExhausted(poolFor(t))) {
      fetchTurn = (fetchTurn + k + 1) % topics.length;
      return t;
    }
  }
  return null;
}

// ---------- Fil ----------

const feedEl = $('#feed');
const tpl = $('#slide-tpl');
let items = [];
let slides = [];
const inFeed = new Set();
let active = -1;
let loadingMore = false;
let outOfVideos = false;

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio >= 0.6) setActive(+e.target.dataset.index);
  }
}, { root: feedEl, threshold: 0.6 });

function subline(v) {
  const parts = [];
  if (v.views) parts.push(`${compact.format(v.views)} vues`);
  if (v.published) parts.push(timeAgo(v.published));
  if (v.duration) parts.push(formatDuration(v.duration));
  return parts.join(' · ');
}

function makeSlide(v, index) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.index = index;
  el.classList.toggle('wide', !v.vertical);
  $('.topic', el).textContent = filter === 'all' || filter === 'fav' ? topicById(v.topic)?.q || '' : '';
  $('.channel', el).textContent = v.channel;
  $('.title', el).textContent = v.title;
  $('.sub', el).textContent = subline(v);
  $('[data-action="fav"]', el).classList.toggle('on', isFav(v.id));
  return el;
}

function append(videos) {
  const frag = document.createDocumentFragment();
  for (const v of videos) {
    const el = makeSlide(v, items.length);
    items.push(v);
    slides.push(el);
    inFeed.add(v.id);
    frag.append(el);
    io.observe(el);
  }
  feedEl.append(frag);
  hideEmpty();
  loadThumbs();
}

function reindex() {
  slides.forEach((el, i) => { el.dataset.index = i; });
}

function setThumb(img, v) {
  const fallback = () => {
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  };
  // Une miniature absente revient en petite image grise de 120 px.
  img.onload = () => { if (img.naturalWidth <= 120) fallback(); };
  img.onerror = fallback;
  img.src = `https://i.ytimg.com/vi/${v.id}/${v.vertical ? 'oardefault' : 'hqdefault'}.jpg`;
}

function loadThumbs() {
  const from = Math.max(0, active - 1);
  for (let j = from; j <= Math.max(active, 0) + 3 && j < slides.length; j++) {
    const img = $('.thumb', slides[j]);
    if (!img.dataset.set) {
      img.dataset.set = '1';
      setThumb(img, items[j]);
    }
  }
}

function setActive(i) {
  if (i === active || !items[i]) return;
  slides[active]?.classList.remove('playing', 'paused', 'loading');
  active = i;
  const v = items[i];
  slides[i].classList.add('loading');
  $('.bar', slides[i]).style.width = '0';
  userPaused = false;
  if (filter !== 'fav') {
    seen.add(v.id);
    saveSeen();
  }
  loadThumbs();
  playCurrent();
  saveQueue();
  if (items.length - i <= 6) ensureMore();
  if (i === items.length - 1 && outOfVideos && filter !== 'fav') {
    toast('Tu as tout vu pour ces sujets ! Ajoute des sujets ou élargis les filtres.');
  }
}

function goTo(i) {
  if (i < 0 || i >= slides.length) return;
  feedEl.scrollTo({ top: i * feedEl.clientHeight, behavior: 'smooth' });
}

function saveQueue() {
  if (filter === 'fav') return;
  save('queue', { filter, sig: searchSig(), items: items.slice(active + 1, active + 31) });
}

function resetFeed() {
  io.disconnect();
  feedEl.replaceChildren();
  items = [];
  slides = [];
  inFeed.clear();
  active = -1;
  outOfVideos = false;
  feedEl.scrollTop = 0;
  if (playerReady) player.stopVideo();
}

async function ensureMore() {
  if (loadingMore || outOfVideos || filter === 'fav') return;
  loadingMore = true;
  try {
    let fetches = 0;
    let found = 0;
    const tried = new Set();
    while (items.length - Math.max(active, 0) < 8) {
      const topics = currentTopics();
      if (!topics.length) break;
      // Remplit d'abord les réserves vides, pour que le fil alterne bien
      // entre les sujets dès le départ.
      const hungry = topics.find((t) => {
        const p = poolFor(t);
        return !p.items.length && !poolExhausted(p) && !tried.has(t.id);
      });
      if (hungry && fetches < 4) {
        tried.add(hungry.id);
        fetches++;
        found += await fetchTopic(hungry);
        continue;
      }
      const batch = draw(topics, 10);
      if (batch.length) {
        append(batch);
        continue;
      }
      const t = nextTopicToFetch(topics);
      if (!t) {
        outOfVideos = true;
        break;
      }
      // Au plus 4 recherches d'affilée pour ne pas brûler le quota si les
      // filtres écartent presque tout.
      if (fetches++ >= 4) {
        // Quatre recherches sans rien de nouveau : les filtres sont trop
        // stricts, on arrête de chercher jusqu'au prochain changement.
        if (!found) outOfVideos = true;
        break;
      }
      found += await fetchTopic(t);
    }
    if (!items.length) showEmpty(outOfVideos || currentTopics().length ? 'none' : 'topics');
  } catch (e) {
    handleApiError(e);
  } finally {
    loadingMore = false;
  }
}

function handleApiError(e) {
  if (e.kind === 'key') {
    showEmpty('welcome', e.message);
  } else if (!items.length) {
    showEmpty(e.kind === 'quota' ? 'quota' : 'offline', e.message);
  } else {
    toast(e.message);
  }
}

function start() {
  hideEmpty();
  renderChips();
  if (filter === 'fav') {
    if (!favorites.length) return showEmpty('fav');
    return append(favorites.filter((v) => !isBlocked(v.channelId)));
  }
  if (!settings.apiKey) return showEmpty('welcome');
  if (!enabledTopics().length) return showEmpty('topics');

  const queue = load('queue', null);
  if (queue?.filter === filter && queue.sig === searchSig()) {
    const ids = new Set(currentTopics().map((t) => t.id));
    append(queue.items.filter((v) => ids.has(v.topic) && !seen.has(v.id) && !isBlocked(v.channelId)));
  }
  ensureMore();
}

function restart() {
  returnToPools(items.slice(active + 1));
  resetFeed();
  start();
}

// ---------- Lecteur YouTube ----------

let player = null;
let playerReady = false;
let soundOn = false;
let showPill = true;
let userPaused = false;
let stallTimer = 0;
let soundTimer = 0;
let tapThroughTimer = 0;
let errorStreak = 0;

const soundPill = $('#sound-pill');
const tapHint = $('#tap-hint');

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1,
      mute: 1,
      controls: 0,
      playsinline: 1,
      rel: 0,
      fs: 0,
      disablekb: 1,
      iv_load_policy: 3,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        playerReady = true;
        player.mute();
        if (active >= 0) playCurrent();
      },
      onStateChange,
      onError,
    },
  });
};

function loadPlayerApi() {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => toast('Impossible de charger le lecteur YouTube. Vérifie ta connexion.');
  document.head.append(s);
}

function playCurrent() {
  const v = items[active];
  if (!v || !playerReady) return;
  if (soundOn) player.unMute();
  else player.mute();
  player.loadVideoById(v.id);
  clearTimeout(stallTimer);
  stallTimer = setTimeout(checkStall, 2500);
}

// Certains navigateurs (iPhone surtout) refusent de lancer une vidéo avec le
// son sans geste sur le lecteur : on repasse alors en muet.
function checkStall() {
  if (!playerReady || userPaused) return;
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) return;
  if (soundOn) {
    setSound(false);
    showPill = true;
    updatePill();
  }
  player.playVideo();
}

function onStateChange(e) {
  const S = YT.PlayerState;
  const el = slides[active];
  const current = player.getVideoData?.()?.video_id;
  if (!el || (current && current !== items[active]?.id)) return;

  if (e.data === S.PLAYING) {
    errorStreak = 0;
    el.classList.add('playing');
    el.classList.remove('loading', 'paused');
    if (document.body.classList.contains('tap-through') && (!soundOn || !player.isMuted())) endTapThrough();
    updatePill();
  } else if (e.data === S.BUFFERING) {
    if (!el.classList.contains('playing')) el.classList.add('loading');
  } else if (e.data === S.PAUSED) {
    el.classList.remove('loading');
    el.classList.add('paused');
    if (document.body.classList.contains('tap-through') && soundOn) {
      player.unMute();
      player.playVideo();
    }
  } else if (e.data === S.ENDED) {
    if (settings.autoNext && active < items.length - 1) {
      goTo(active + 1);
    } else {
      player.seekTo(0, true);
      player.playVideo();
    }
  }
}

function onError(e) {
  const v = items[active];
  if (!v) return;
  errorStreak++;
  if (errorStreak >= 4) {
    toast('Le lecteur YouTube refuse de lire les vidéos ici. Recharge la page.');
    return;
  }
  const embedBlocked = e.data === 101 || e.data === 150;
  toast(embedBlocked ? 'Vidéo non lisible hors de YouTube, on passe.' : 'Vidéo indisponible, on passe.');
  setTimeout(() => {
    if (items[active] === v) goTo(active + 1);
  }, 700);
}

function setSound(on) {
  soundOn = on;
  document.body.classList.toggle('muted', !on);
  updatePill();
  if (!playerReady) return;
  clearTimeout(soundTimer);
  if (!on) {
    player.mute();
    return;
  }
  player.unMute();
  player.setVolume(100);
  if (player.getPlayerState() !== YT.PlayerState.PLAYING && !userPaused) player.playVideo();
  // Si le navigateur a coupé la vidéo ou gardé le son coupé, il faut un vrai
  // toucher sur le lecteur lui-même.
  soundTimer = setTimeout(() => {
    if (!soundOn) return;
    if (player.getPlayerState() !== YT.PlayerState.PLAYING || player.isMuted()) startTapThrough();
  }, 900);
}

function startTapThrough() {
  document.body.classList.add('tap-through');
  tapHint.hidden = false;
  clearTimeout(tapThroughTimer);
  tapThroughTimer = setTimeout(() => {
    if (!document.body.classList.contains('tap-through')) return;
    endTapThrough();
    setSound(false);
    showPill = true;
    updatePill();
  }, 12000);
}

function endTapThrough() {
  document.body.classList.remove('tap-through');
  tapHint.hidden = true;
  clearTimeout(tapThroughTimer);
}

function updatePill() {
  const playing = slides[active]?.classList.contains('playing');
  soundPill.hidden = soundOn || !showPill || !playing || !$('#settings').hidden;
}

function togglePlay() {
  if (!playerReady) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    userPaused = true;
    player.pauseVideo();
  } else {
    userPaused = false;
    player.playVideo();
  }
}

setInterval(() => {
  const el = slides[active];
  if (!playerReady || !el?.classList.contains('playing')) return;
  const d = player.getDuration?.() || 0;
  const t = player.getCurrentTime?.() || 0;
  $('.bar', el).style.width = d ? `${Math.min(100, (t / d) * 100)}%` : '0';
}, 200);

// ---------- Gestes sur le fil ----------

let lastTap = 0;
let tapTimer = 0;

feedEl.addEventListener('click', (e) => {
  const slide = e.target.closest('.slide');
  if (!slide) return;
  const index = +slide.dataset.index;

  const btn = e.target.closest('[data-action]');
  if (btn) return slideAction(btn.dataset.action, index, btn);

  const prog = e.target.closest('.progress');
  if (prog && index === active && playerReady) {
    const r = prog.getBoundingClientRect();
    player.seekTo(((e.clientX - r.left) / r.width) * (player.getDuration() || 0), true);
    return;
  }

  const now = Date.now();
  if (now - lastTap < 300) {
    clearTimeout(tapTimer);
    lastTap = 0;
    heartBurst(slide, e);
    if (!isFav(items[index].id)) toggleFav(index);
    return;
  }
  lastTap = now;
  tapTimer = setTimeout(() => {
    if (index !== active) return;
    if (!soundOn) {
      showPill = false;
      setSound(true);
    } else {
      togglePlay();
    }
  }, 260);
});

function heartBurst(slide, e) {
  const r = slide.getBoundingClientRect();
  const b = document.createElement('div');
  b.className = 'burst';
  b.style.left = `${e.clientX - r.left}px`;
  b.style.top = `${e.clientY - r.top}px`;
  slide.append(b);
  b.addEventListener('animationend', () => b.remove());
}

function slideAction(action, index, btn) {
  const v = items[index];
  if (!v) return;
  if (action === 'fav') {
    toggleFav(index);
  } else if (action === 'sound') {
    showPill = false;
    setSound(!soundOn);
  } else if (action === 'open') {
    if (playerReady && index === active) player.pauseVideo();
    window.open(v.vertical ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`, '_blank', 'noopener');
  } else if (action === 'block') {
    blockChannel(index);
  }
  btn.blur();
}

function toggleFav(index) {
  const v = items[index];
  if (isFav(v.id)) {
    favorites = favorites.filter((x) => x.id !== v.id);
  } else {
    favorites.unshift(v);
    favorites = favorites.slice(0, 500);
  }
  saveFavorites();
  const on = isFav(v.id);
  for (const [i, el] of slides.entries()) {
    if (items[i].id === v.id) $('[data-action="fav"]', el).classList.toggle('on', on);
  }
  renderChips();
}

function blockChannel(index) {
  const v = items[index];
  if (!v.channelId || isBlocked(v.channelId)) return;
  settings.blocked.push({ id: v.channelId, title: v.channel });
  saveSettings();

  // Retire les vidéos suivantes de cette chaîne, garde l'historique.
  for (let j = slides.length - 1; j > index; j--) {
    if (items[j].channelId !== v.channelId) continue;
    io.unobserve(slides[j]);
    slides[j].remove();
    slides.splice(j, 1);
    inFeed.delete(items[j].id);
    items.splice(j, 1);
  }
  reindex();
  loadThumbs();
  ensureMore();
  toast(`Chaîne « ${v.channel} » masquée.`, {
    label: 'Annuler',
    run: () => {
      settings.blocked = settings.blocked.filter((c) => c.id !== v.channelId);
      saveSettings();
    },
  });
  if (index === active) goTo(active + 1);
}

// Clavier (ordinateur)
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || !$('#settings').hidden || !$('#empty').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'j') goTo(active + 1);
  else if (e.key === 'ArrowUp' || e.key === 'k') goTo(active - 1);
  else if (e.key === ' ') togglePlay();
  else if (e.key === 'm') { showPill = false; setSound(!soundOn); }
  else return;
  e.preventDefault();
});

// Garde la diapo active bien calée après une rotation ou un redimensionnement.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (active >= 0) feedEl.scrollTop = active * feedEl.clientHeight;
  }, 150);
});

let wasPlaying = false;
document.addEventListener('visibilitychange', () => {
  if (!playerReady) return;
  if (document.hidden) {
    wasPlaying = player.getPlayerState() === YT.PlayerState.PLAYING;
    player.pauseVideo();
  } else if (wasPlaying && $('#settings').hidden) {
    player.playVideo();
  }
});

soundPill.addEventListener('click', () => {
  showPill = false;
  setSound(true);
});

// ---------- Puces de sujets ----------

function renderChips() {
  const nav = $('#chips');
  const list = [['all', 'Tout'], ...enabledTopics().map((t) => [t.id, t.q])];
  if (favorites.length) list.push(['fav', '♥ Favoris']);
  if (!list.some(([id]) => id === filter)) {
    filter = 'all';
    save('filter', filter);
  }
  nav.replaceChildren(...list.map(([id, label]) => {
    const b = document.createElement('button');
    b.className = `chip${id === filter ? ' on' : ''}`;
    b.textContent = label;
    b.onclick = () => setFilter(id);
    return b;
  }));
  nav.hidden = list.length < 2;
}

function setFilter(id) {
  if (id === filter) {
    goTo(0);
    return;
  }
  returnToPools(items.slice(active + 1));
  filter = id;
  save('filter', filter);
  resetFeed();
  start();
  $('#chips .on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// ---------- Écrans vides et accueil ----------

const emptyEl = $('#empty');

const SUGGESTIONS = [
  'recettes rapides', 'impression 3D', 'astuces bricolage', 'vulgarisation scientifique',
  'espace et astronomie', 'histoire', 'programmation', 'nouvelles technologies',
  'animaux drôles', 'voyage', 'fitness à la maison', 'jeux vidéo', 'dessin',
  'musique live', 'nature', 'humour',
];

const KEY_STEPS = `
  <ol class="steps">
    <li>Ouvre <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a> avec ton compte Google et crée un projet (nomme-le « SmartScroll »).</li>
    <li>Active <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a> avec le bouton <b>Activer</b>.</li>
    <li>Va dans <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Identifiants</a> → <b>Créer des identifiants</b> → <b>Clé API</b>.</li>
    <li>Copie la clé et colle-la ci-dessous.</li>
  </ol>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showEmpty(kind, message = '') {
  emptyEl.hidden = false;
  emptyEl.classList.toggle('under-bar', kind !== 'welcome');
  const err = message ? `<p class="error">${escapeHtml(message)}</p>` : '';

  if (kind === 'welcome') {
    emptyEl.innerHTML = `
      <div class="empty-inner">
        <img class="logo" src="icons/icon-192.png" alt="">
        <h1>Ton fil, tes sujets.</h1>
        <p>SmartScroll te montre des vidéos YouTube en plein écran, comme TikTok, mais uniquement sur les sujets que tu choisis.</p>
        <p>Pour chercher les vidéos, il faut une clé gratuite de YouTube. Ça se fait une seule fois, en 5 minutes environ :</p>
        ${KEY_STEPS}
        ${err}
        <form class="add-row" id="welcome-key">
          <input type="password" placeholder="Clé (AIza…) ou lien de configuration" autocomplete="off" spellcheck="false" value="${escapeHtml(settings.apiKey)}">
          <button type="submit" class="add-btn" aria-label="Valider">✓</button>
        </form>
        <p class="hint" style="margin-top:14px">Déjà configuré sur un autre appareil ? Dans ses réglages, touche « Copier le lien de configuration », puis colle ce lien dans le champ ci-dessus.</p>
      </div>`;
    $('#welcome-key', emptyEl).onsubmit = async (e) => {
      e.preventDefault();
      const input = $('input', e.target);
      if (importSetup(input.value)) return restart();
      const btn = $('button', e.target);
      btn.disabled = true;
      const ok = await saveKey(input.value);
      btn.disabled = false;
      if (ok) restart();
    };
    return;
  }

  if (kind === 'topics') {
    const picked = new Set();
    emptyEl.innerHTML = `
      <div class="empty-inner">
        <h1>Qu'est-ce que tu veux voir ?</h1>
        <p>Choisis quelques sujets ou écris les tiens. Plus c'est précis, mieux c'est. Tu pourras les changer à tout moment dans les réglages.</p>
        <div class="suggestions">${SUGGESTIONS.map((s) => `<button type="button">${escapeHtml(s)}</button>`).join('')}</div>
        <form class="add-row" id="own-topic">
          <input type="text" placeholder="Un autre sujet…" autocomplete="off" enterkeyhint="done">
          <button type="submit" class="add-btn" aria-label="Ajouter">+</button>
        </form>
        <button class="btn-primary" id="go" style="margin-top:22px" disabled>C'est parti</button>
      </div>`;
    const go = $('#go', emptyEl);
    const box = $('.suggestions', emptyEl);
    const refresh = () => { go.disabled = !picked.size; };
    box.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const q = b.textContent;
      if (picked.has(q)) picked.delete(q); else picked.add(q);
      b.classList.toggle('on', picked.has(q));
      refresh();
    };
    $('#own-topic', emptyEl).onsubmit = (e) => {
      e.preventDefault();
      const input = $('input', e.target);
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      if (!picked.has(q)) {
        picked.add(q);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'on';
        b.textContent = q;
        box.prepend(b);
      }
      refresh();
    };
    go.onclick = () => {
      for (const q of picked) addTopic(q);
      restart();
    };
    return;
  }

  const screens = {
    none: ['Rien trouvé', "Aucune vidéo ne correspond à tes sujets et filtres. Essaie des sujets plus larges, une autre langue ou l'ancienneté « Toutes »."],
    fav: ['Pas encore de favoris', 'Touche le cœur ou tape deux fois sur une vidéo pour la garder ici.'],
    quota: ['Quota du jour épuisé', 'YouTube limite le nombre de recherches par jour. Le compteur repart à zéro vers 9 h. Tes favoris restent disponibles.'],
    offline: ['Pas de vidéos pour le moment', ''],
  };
  const [title, text] = screens[kind];
  emptyEl.innerHTML = `
    <div class="empty-inner">
      <h1>${title}</h1>
      ${text ? `<p>${text}</p>` : ''}
      ${kind === 'quota' ? '' : err}
      ${kind === 'offline' ? '<button class="btn-primary" id="retry">Réessayer</button>' : ''}
      ${kind === 'none' ? '<button class="btn-primary" id="open-settings">Modifier mes sujets</button>' : ''}
    </div>`;
  $('#retry', emptyEl)?.addEventListener('click', restart);
  $('#open-settings', emptyEl)?.addEventListener('click', openSettings);
}

function hideEmpty() {
  emptyEl.hidden = true;
  emptyEl.replaceChildren();
}

async function saveKey(raw) {
  const key = raw.trim();
  if (!key) return false;
  try {
    await api('i18nLanguages', { part: 'snippet', hl: 'fr' }, 1, key);
  } catch (e) {
    if (e.kind === 'quota') {
      // Le quota est épuisé mais la clé fonctionne.
    } else {
      toast(e.kind === 'network' ? e.message : e.message || 'Clé refusée par YouTube.');
      return false;
    }
  }
  settings.apiKey = key;
  saveSettings();
  toast('Clé enregistrée ✓');
  return true;
}

// ---------- Toast ----------

const toastEl = $('#toast');
let toastTimer = 0;

function toast(message, action) {
  toastEl.replaceChildren(document.createTextNode(message));
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => {
      toastEl.classList.remove('show');
      action.run();
    };
    toastEl.append(b);
  }
  toastEl.style.pointerEvents = action ? 'auto' : 'none';
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), action ? 5000 : 3200);
}

// ---------- Réglages ----------

const settingsEl = $('#settings');
let settingsSnapshot = '';

const feedSig = () => searchSig() + JSON.stringify(settings.topics) + settings.apiKey;

function addTopic(q) {
  q = q.trim().replace(/\s+/g, ' ');
  if (!q || settings.topics.some((t) => normalize(t.q) === normalize(q))) return;
  settings.topics.push({ id: rid(), q, on: true });
  saveSettings();
}

function openSettings() {
  settingsSnapshot = feedSig();
  renderSettings();
  settingsEl.hidden = false;
  updatePill();
  if (playerReady) player.pauseVideo();
}

function closeSettings() {
  settingsEl.hidden = true;
  if (feedSig() !== settingsSnapshot) {
    for (const id of Object.keys(pools)) if (!topicById(id)) delete pools[id];
    savePools();
    restart();
  } else {
    renderChips();
    if (playerReady && active >= 0 && !userPaused) player.playVideo();
    else if (!items.length) start();
  }
  updatePill();
}

function renderSettings() {
  const topicList = $('#topic-list');
  topicList.replaceChildren(...settings.topics.map((t) => {
    const li = document.createElement('li');
    li.className = t.on ? '' : 'off';
    li.innerHTML = `
      <label class="switch"><input type="checkbox" ${t.on ? 'checked' : ''} aria-label="Activer"><span></span></label>
      <span class="name"></span>
      <button class="del-btn" aria-label="Supprimer">×</button>`;
    $('.name', li).textContent = t.q;
    $('input', li).onchange = (e) => {
      t.on = e.target.checked;
      li.className = t.on ? '' : 'off';
      saveSettings();
    };
    $('.del-btn', li).onclick = () => {
      settings.topics = settings.topics.filter((x) => x !== t);
      saveSettings();
      renderSettings();
    };
    return li;
  }));

  const excludeList = $('#exclude-list');
  excludeList.replaceChildren(...settings.exclude.map((w) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.append(w);
    const b = document.createElement('button');
    b.textContent = '×';
    b.setAttribute('aria-label', `Retirer ${w}`);
    b.onclick = () => {
      settings.exclude = settings.exclude.filter((x) => x !== w);
      saveSettings();
      renderSettings();
    };
    span.append(b);
    return span;
  }));

  for (const seg of settingsEl.querySelectorAll('.seg')) {
    const value = String(settings[seg.dataset.setting]);
    for (const b of seg.children) b.classList.toggle('on', b.dataset.value === value);
  }

  const blocked = $('#blocked-list');
  blocked.replaceChildren(...settings.blocked.map((c) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><button class="restore-btn">Réafficher</button>';
    $('.name', li).textContent = c.title || c.id;
    $('button', li).onclick = () => {
      settings.blocked = settings.blocked.filter((x) => x !== c);
      saveSettings();
      renderSettings();
    };
    return li;
  }));
  $('#blocked-group').hidden = !settings.blocked.length;

  $('#key-input').value = settings.apiKey;
  const used = usedQuota();
  const searches = Math.max(0, Math.floor((10000 - used) / 101));
  $('#quota-line').textContent = settings.apiKey
    ? `Aujourd'hui : ${used.toLocaleString('fr-FR')} / 10 000 unités utilisées, soit environ ${searches} recherches restantes (une recherche ramène jusqu'à 50 vidéos). Remise à zéro vers 9 h.`
    : '';
  $('#seen-line').textContent = `${seen.size.toLocaleString('fr-FR')} vidéo${seen.size > 1 ? 's' : ''} déjà vue${seen.size > 1 ? 's' : ''} : elles ne reviennent pas dans le fil.`;
}

$('#btn-settings').onclick = openSettings;
$('#btn-close-settings').onclick = closeSettings;

$('#topic-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#topic-input');
  addTopic(input.value);
  input.value = '';
  renderSettings();
};

$('#exclude-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#exclude-input');
  const w = input.value.trim().replace(/^-+/, '');
  input.value = '';
  if (w && !settings.exclude.some((x) => normalize(x) === normalize(w))) {
    settings.exclude.push(w);
    saveSettings();
  }
  renderSettings();
};

$('#key-form').onsubmit = async (e) => {
  e.preventDefault();
  const value = $('#key-input').value;
  if (!importSetup(value)) await saveKey(value);
  renderSettings();
};

settingsEl.addEventListener('click', (e) => {
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const key = segBtn.parentElement.dataset.setting;
    const value = segBtn.dataset.value;
    settings[key] = key === 'autoNext' ? value === 'true' : value;
    saveSettings();
    renderSettings();
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'key-guide') {
    settingsEl.hidden = true;
    showEmpty('welcome');
  } else if (action === 'copy-setup') {
    shareSetup();
  } else if (action === 'reset-seen') {
    seen.clear();
    saveSeen();
    for (const p of Object.values(pools)) p.day = '';
    savePools();
    renderSettings();
    toast('Historique effacé : les vidéos déjà vues pourront revenir.');
  }
});

// ---------- Lien de configuration (autres appareils) ----------

function encodeSetup() {
  const { apiKey, topics, exclude, format, lang, period, order, autoNext, blocked } = settings;
  const bytes = new TextEncoder().encode(JSON.stringify({ apiKey, topics, exclude, format, lang, period, order, autoNext, blocked }));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSetup(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

// Adresse publique de l'appli : un lien créé depuis le Mac en local doit
// quand même ouvrir la version en ligne sur le téléphone.
const PUBLIC_URL = 'https://smartscroll.ivwi.fr/';

async function shareSetup() {
  const local = /^(localhost|127\.|10\.|192\.168\.)/.test(location.hostname);
  const base = local ? PUBLIC_URL : `${location.origin}${location.pathname}`;
  const url = `${base}#setup=${encodeSetup()}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: 'SmartScroll', url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('Lien copié. Ouvre-le sur ton autre appareil.');
  } catch (e) {
    if (e?.name === 'AbortError') return;
    window.prompt('Copie ce lien :', url);
  }
}

// Importe un lien de configuration, ouvert ou collé dans le champ de la clé.
// Le collage sert sur iPhone : l'appli installée sur l'écran d'accueil ne
// partage pas ses données avec Safari, où s'ouvrent les liens.
// Renvoie false si le texte n'est pas un lien de configuration.
function importSetup(text) {
  const m = /#setup=([\w-]+)/.exec(text);
  if (!m) return false;
  try {
    const data = decodeSetup(m[1]);
    for (const k of Object.keys(DEFAULTS)) if (k in data) settings[k] = data[k];
    saveSettings();
    toast('Configuration importée ✓');
  } catch {
    toast('Ce lien de configuration est abîmé.');
  }
  return true;
}

function importSetupFromHash() {
  const hash = location.hash;
  if (!hash.startsWith('#setup=')) return;
  history.replaceState(null, '', location.pathname + location.search);
  importSetup(hash);
}

// ---------- Démarrage ----------

document.body.classList.add('muted');
importSetupFromHash();
loadPlayerApi();
start();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
