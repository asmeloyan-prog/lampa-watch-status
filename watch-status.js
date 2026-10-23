/* Lampa Watch Status 1.0.3 — local marks, no CUB Premium required. */
(function () {
    'use strict';
    if (window.lampa_watch_status) return;
    var L, menuCard, fullRoot, fullCard, known = {}, seasons = {}, pending = {}, timer, paintTimer;
    var VERSION = '1.0.3', THRESHOLD = 95, EPISODE_THRESHOLD = 90, TTL = 6 * 60 * 60 * 1000;
    var scanQueue = [], scanQueued = {}, scanBusy = false;

    function tv(card) { return !!(card.original_name || card.first_air_date || card.media_type === 'tv' || card.number_of_seasons); }
    function key(card) {
        if (!card || !card.id) return '';
        return (card.source === 'cub' ? 'tmdb' : (card.source || 'tmdb')) + ':' + (tv(card) ? 'tv:' : 'movie:') + card.id;
    }
    function scope() { return 'lampa_watch_status_v1_' + L.Timeline.filename(); }
    function records() { return L.Storage.get(scope(), {}) || {}; }
    function record(card) { return records()[key(card)] || {}; }
    function remember(card) { if (key(card)) known[key(card)] = card; }
    function status(card) {
        var entry = record(card);
        return entry.status || (L.Favorite.check(card).wath ? 'planned' : '');
    }
    function notify(card) {
        L.Listener.send('state:changed', { target: 'favorite', reason: 'watch-status', card: card });
    }
    function refreshContinueScreens() {
        if (typeof L.Activity.all !== 'function') return;
        L.Activity.all().forEach(function (screen) {
            if ((screen.component === 'main' || screen.component === 'category') && screen.activity && typeof screen.activity.refresh === 'function') {
                // Native refresh defers rebuilding an inactive screen until the user returns.
                screen.activity.refresh();
            }
        });
    }
    function write(card, entry) {
        var data = records();
        var changed = (data[key(card)] || {}).status !== entry.status;
        data[key(card)] = entry;
        L.Storage.set(scope(), data);
        notify(card);
        if (changed) refreshContinueScreens();
    }
    function setStatus(card, value, automatic) {
        if (!key(card)) return;
        var entry = record(card);
        if (automatic && (entry.status === 'skip' || entry.hold)) return;
        if (entry.status === value && !!entry.auto === !!automatic) return;
        remember(card);
        write(card, { status: value, auto: !!automatic, hold: !automatic && !value, updated: Date.now() });
        if (value && L.Favorite.check(card).wath) L.Favorite.remove('wath', card);
    }
    function hidden(card) { var value = status(card); return value === 'viewed' || value === 'skip'; }
    function complete(road, threshold) {
        // Numeric legacy timecodes and opening/eye marks are not completion evidence.
        if (!road || typeof road !== 'object') return false;
        threshold = threshold || THRESHOLD;
        var percent = Number(road.percent), duration = Number(road.duration), time = Number(road.time);
        return isFinite(percent) && percent >= threshold && percent <= 100 &&
            isFinite(duration) && duration > 0 && isFinite(time) && time >= duration * threshold / 100;
    }
    function movieRoad(card) { return L.Timeline.watched(card, true); }
    function episodeRoad(card, season, episode) { return L.Timeline.watchedEpisode(card, season, episode, true); }
    function evaluate(card) {
        var entry = record(card);
        if (entry.status === 'skip' || entry.hold || (entry.status === 'viewed' && !entry.auto)) return;
        if (!tv(card)) {
            if (complete(movieRoad(card))) setStatus(card, 'viewed', true);
            return;
        }
        var cache = seasons[key(card)];
        if (!cache || !cache.episodes.length) return;
        var done = cache.episodes.every(function (ep) { return complete(episodeRoad(card, ep.season, ep.episode), EPISODE_THRESHOLD); });
        if (done) {
            if (entry.status !== 'viewed') setStatus(card, 'viewed', true);
        } else if (entry.status === 'viewed' && entry.auto) {
            // A new episode or explicitly reset timecode restores an automatically completed show.
            setStatus(card, '', true);
        }
    }
    function today() { return new Date().toISOString().slice(0, 10); }
    function validDate(date) {
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        var stamp = Date.parse(date + 'T00:00:00Z');
        return isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date;
    }
    function aired(date) { return validDate(date) && date <= today(); }
    function loadSeries(card, onDone) {
        onDone = onDone || function () {};
        var id = key(card), source = card.source || 'tmdb';
        if (!tv(card) || (source !== 'tmdb' && source !== 'cub') || pending[id]) return onDone();
        var cache = seasons[id];
        if (cache && Date.now() - cache.time < TTL && cache.day === today()) { evaluate(card); return onDone(); }
        var api = L.Api.sources.tmdb, profile = scope();
        if (!api || typeof api.get !== 'function') return onDone();
        pending[id] = true;
        var finished = false;
        var timeout;
        function armTimeout() { clearTimeout(timeout); timeout = setTimeout(fail, 15000); }
        function fail() {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            delete pending[id];
            // Throttle failures too; never use a partial season response for completion.
            seasons[id] = { time: Date.now() - TTL + 60000, day: today(), episodes: [] };
            onDone();
        }
        armTimeout();
        try {
            api.get('tv/' + card.id, {}, function (show) {
                if (finished) return;
                var list = show && show.seasons;
                if (!Array.isArray(list) || !list.length) return fail();
                // Unknown dates/counts on potentially released seasons make the inventory uncertain.
                var regular = list.filter(function (s) { return s.season_number > 0; });
                regular.sort(function (a, b) { return a.season_number - b.season_number; });
                if ((show.number_of_seasons && show.number_of_seasons !== regular.length) || regular.some(function (s, i) {
                    return s.season_number !== i + 1 || !validDate(s.air_date) || !Number.isInteger(s.episode_count) || s.episode_count < 0;
                })) return fail();
                var released = regular.filter(function (s) { return aired(s.air_date) && s.episode_count > 0; });
                if (!released.length) return fail();
                var episodes = [], index = 0;
                function next() {
                    if (finished || profile !== scope()) return fail();
                    if (index === released.length) {
                        finished = true;
                        clearTimeout(timeout);
                        delete pending[id];
                        seasons[id] = { time: Date.now(), day: today(), episodes: episodes };
                        evaluate(card);
                        onDone();
                        return;
                    }
                    var s = released[index++];
                    armTimeout();
                    api.get('tv/' + card.id + '/season/' + s.season_number, {}, function (data) {
                        if (finished) return;
                        if (!data || !Array.isArray(data.episodes) || data.episodes.length !== s.episode_count) return fail();
                        var seen = {};
                        for (var i = 0; i < data.episodes.length; i++) {
                            var ep = data.episodes[i];
                            if (!Number.isInteger(ep.episode_number) || ep.episode_number < 1 || ep.episode_number > s.episode_count || seen[ep.episode_number] || !validDate(ep.air_date)) return fail();
                            seen[ep.episode_number] = true;
                            if (aired(ep.air_date)) episodes.push({ season: s.season_number, episode: ep.episode_number });
                        }
                        next();
                    }, fail);
                }
                next();
            }, fail);
        } catch (error) { fail(); }
    }
    function scanNext() {
        if (scanBusy) return;
        var job = scanQueue.shift();
        if (!job) return;
        if (job.profile !== scope()) { delete scanQueued[job.id]; return scanNext(); }
        scanBusy = true;
        loadSeries(job.card, function () {
            delete scanQueued[job.id];
            scanBusy = false;
            scanNext();
        });
    }
    function scanSeries(card) {
        var entry = record(card), id = scope() + ':' + key(card);
        if (entry.status === 'skip' || entry.hold || (entry.status === 'viewed' && !entry.auto) || scanQueued[id]) return;
        scanQueued[id] = true;
        scanQueue.push({ id: id, profile: scope(), card: card });
        scanNext();
    }
    function filter(cards) {
        return cards.filter(function (card) {
            remember(card);
            if (tv(card)) scanSeries(card);
            return !hidden(card);
        });
    }
    function items(card) {
        var current = status(card);
        return ['viewed', 'skip'].map(function (value) {
            function toggle() {
                setStatus(card, status(card) === value ? '' : value, false);
                // Reopen with fresh native/planned checkbox state on the next menu invocation.
                L.Select.close();
            }
            return {
                title: value === 'viewed' ? 'Просмотрено' : 'Не буду смотреть',
                subtitle: 'Локальная отметка',
                checkbox: true, checked: current === value, watchStatus: value,
                onCheck: toggle, onSelect: toggle
            };
        });
    }
    function marker(root, card) {
        if (!root || !root.querySelector) return;
        var mark = root.querySelector('[data-watch-status]'), value = status(card);
        if (mark) mark.remove();
        if (value !== 'viewed' && value !== 'skip') return;
        var target = root.querySelector('.card__view') || root.querySelector('.full-start-new__poster');
        if (!target) return;
        // Reuse Lampa's label shape and colours, never its Premium status storage.
        var old = target.querySelector('.card__marker');
        if (old) old.remove();
        mark = document.createElement('div');
        mark.className = 'card__marker card__marker--' + (value === 'viewed' ? 'viewed' : 'thrown');
        mark.setAttribute('data-watch-status', value);
        var span = document.createElement('span');
        span.textContent = value === 'viewed' ? 'Просмотрено' : 'Не буду смотреть';
        mark.appendChild(span); target.appendChild(mark);
    }
    function patchCards() {
        var favorite = L.Maker.map('Card').Favorite;
        if (favorite) {
            var create = favorite.onCreate, paint = favorite.onFavorite;
            favorite.onCreate = function () {
                create.apply(this, arguments);
                remember(this.data);
                var card = this.data, group = this.menu_list[this.menu_list.length - 1], original = group.menu;
                group.menu = function () {
                    var menu = original.apply(this, arguments);
                    var at = menu.findIndex(function (item) { return item.where === 'wath'; });
                    if (at >= 0) { menu[at].title = 'К просмотру'; menu.splice.apply(menu, [at + 1, 0].concat(items(card))); }
                    return menu;
                };
            };
            favorite.onFavorite = function () { paint.apply(this, arguments); marker(this.html, this.data); };
        }
        // Deprecated Card still occurs in older third-party components. Scope its synchronous menu call.
        var Card = L.Card;
        if (Card) {
            L.Card = function () {
                Card.apply(this, arguments);
                var original = this.onMenu, paint = this.favorite, card = this.data;
                this.onMenu = function () {
                    var previous = menuCard; menuCard = card;
                    try { return original.apply(this, arguments); } finally { menuCard = previous; }
                };
                this.favorite = function () { var result = paint.apply(this, arguments); marker(this.card, card); return result; };
            };
            L.Card.prototype = Card.prototype;
            Object.keys(Card).forEach(function (name) { L.Card[name] = Card[name]; });
        }
        var show = L.Select.show;
        L.Select.show = function (params) {
            var list = params && params.items, activity = L.Activity.active();
            var card = menuCard || (activity && activity.component === 'full' && activity.card);
            if (!card || !list || list.some(function (item) { return item.watchStatus; })) return show.apply(this, arguments);
            var at = list.findIndex(function (item) { return item.where === 'wath' || item.type === 'wath'; });
            if (at < 0) return show.apply(this, arguments);
            var copy = Object.assign({}, params), check = params.onCheck, select = params.onSelect;
            copy.items = list.slice();
            copy.items[at] = Object.assign({}, copy.items[at], { title: 'К просмотру' });
            copy.items.splice.apply(copy.items, [at + 1, 0].concat(items(card)));
            copy.onCheck = function (item) { if (item.watchStatus) return item.onCheck(); if (check) return check.apply(this, arguments); };
            copy.onSelect = function (item) {
                if (item.watchStatus) { item.onSelect(); return; }
                if (select) return select.apply(this, arguments);
            };
            return show.call(this, copy);
        };
    }
    function onProgress(event) {
        var data = event && event.data, road = data && data.road;
        if (!road) return;
        var matches = Object.keys(known).filter(function (id) {
            var card = known[id], linked = L.Timeline.link && L.Timeline.link(card, 1, 1);
            var matched = road.card && linked && road.card === linked.card;
            if (!road.card && !tv(card)) matched = String(movieRoad(card).hash) === String(data.hash);
            if (!road.card && tv(card)) {
                var cache = seasons[id];
                matched = cache && cache.episodes.some(function (ep) { return String(episodeRoad(card, ep.season, ep.episode).hash) === String(data.hash); });
            }
            return matched;
        });
        // Old hash-only plugins can collide on titles. Do not guess which card was played.
        if (matches.length !== 1) return;
        matches.forEach(function (id) {
            var card = known[id];
            var entry = record(card);
            if (entry.hold && Number(road.percent) < 90) { entry.hold = false; write(card, entry); }
            if (tv(card)) loadSeries(card);
            else evaluate(card);
        });
    }
    function init() {
        // Lampa exposes its APIs before Favorite.init/Timeline.init have read storage.
        // Installing hooks or reading history during plugin loading leaves a partial setup.
        if (!window.appready) return false;
        if (!window.Lampa || !window.Lampa.Timeline) return false;
        L = window.Lampa;
        if (!L || !L.Maker || !L.Timeline || !L.Timeline.filename || !L.ContentRows || !L.Favorite || !L.Select || !L.Player) return false;
        window.lampa_watch_status = { version: VERSION, status: status };
        patchCards();
        L.Favorite.listener.follow('add,added', function (event) {
            if (event.where !== 'wath') return;
            // The built-in planned checkbox takes precedence over either local mark.
            write(event.card, { status: '', auto: false, hold: true, updated: Date.now() });
        });
        var continues = L.Favorite.continues;
        L.Favorite.continues = function () { return filter(continues.apply(this, arguments)); };
        var rows = L.ContentRows.call;
        L.ContentRows.call = function (screen, params, calls) {
            var before = calls.slice();
            var result = rows.apply(this, arguments);
            calls.forEach(function (call, index) {
                if (typeof call !== 'function' || before.indexOf(call) >= 0) return;
                calls[index] = function (done) {
                    return call(function (payload) {
                        if (payload && Array.isArray(payload.results) &&
                            (payload.title === L.Lang.translate('title_continue') || payload.title === L.Lang.translate('title_watched'))) {
                            payload = Object.assign({}, payload, { results: filter(payload.results) });
                        }
                        done(payload);
                    });
                };
            });
            return result;
        };
        L.Listener.follow('full', function (event) {
            var card = event.data && event.data.movie;
            if (!card || event.type !== 'complite') return;
            remember(card);
            if (tv(card)) loadSeries(card); else evaluate(card);
            fullRoot = event.body && (event.body[0] || event.body);
            fullCard = card;
            marker(fullRoot, card);
        });
        L.Listener.follow('state:changed', function (event) {
            if (event.target === 'favorite') {
                // Native full-card listeners repaint synchronously after this listener.
                clearTimeout(paintTimer);
                paintTimer = setTimeout(function () { if (fullRoot && fullCard) marker(fullRoot, fullCard); }, 0);
            }
        });
        L.Player.listener.follow('start,external', function (data) {
            if (!data || data.iptv || data.tv || !data.card) return;
            remember(data.card);
            if (tv(data.card)) loadSeries(data.card);
        });
        L.Timeline.listener.follow('update', onProgress);
        L.Timeline.listener.follow('read', function () { seasons = {}; known = {}; L.Favorite.get({ type: 'history' }).forEach(remember); });
        L.Favorite.get({ type: 'history' }).forEach(function (card) { remember(card); if (!tv(card)) evaluate(card); });
        // The first main screen may have been built before app-ready and before our hooks.
        refreshContinueScreens();
        return true;
    }
    var attempts = 0;
    if (!init()) timer = setInterval(function () { if (init() || ++attempts >= 60) clearInterval(timer); }, 1000);
}());
