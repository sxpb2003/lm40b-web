(function () {
    'use strict';

    const SVC_FFB0 = '0000ffb0-0000-1000-8000-00805f9b34fb';
    const CHR_FFB2 = '0000ffb2-0000-1000-8000-00805f9b34fb';

    const DEFAULT_SETTINGS = {
        repo: 'sxpb2003/lm40b-measurements',
        taskPath: 'task_list.json',
        progressPath: 'progress.json',
        branch: 'main',
        token: ''
    };

    let settings = loadSettings();
    let taskList = [];
    let doneTasks = new Map(); // key -> {meters, ...}
    let syncedKeys = new Set();
    let records = [];

    let selectedDim = '';
    let bluetoothDevice = null;
    let bluetoothServer = null;
    let bluetoothChar = null;

    let measureState = null; // {bldg, floor, hu, room, itemIndex}

    // ===== 初始化 =====
    document.addEventListener('DOMContentLoaded', () => {
        bindEvents();
        loadFromLocalStorage();
        renderHome();
        loadTasks();
        registerServiceWorker();
    });

    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./service-worker.js')
                .then((reg) => console.log('SW registered', reg.scope))
                .catch((err) => console.warn('SW registration failed', err));
        }
    }

    function loadSettings() {
        const saved = localStorage.getItem('lm40b_settings');
        if (saved) {
            try {
                return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(saved));
            } catch (e) {
                console.warn('settings parse error', e);
            }
        }
        return Object.assign({}, DEFAULT_SETTINGS);
    }

    function saveSettings() {
        localStorage.setItem('lm40b_settings', JSON.stringify(settings));
    }

    function loadFromLocalStorage() {
        try {
            const tasks = localStorage.getItem('lm40b_tasks');
            if (tasks) taskList = JSON.parse(tasks).tasks || [];
            const done = localStorage.getItem('lm40b_done');
            if (done) {
                const arr = JSON.parse(done);
                arr.forEach(o => doneTasks.set(taskKey(o), o));
            }
            const synced = localStorage.getItem('lm40b_synced');
            if (synced) syncedKeys = new Set(JSON.parse(synced));
            const recs = localStorage.getItem('lm40b_records');
            if (recs) records = JSON.parse(recs);
        } catch (e) {
            console.warn('local load error', e);
        }
    }

    function saveToLocalStorage() {
        localStorage.setItem('lm40b_tasks', JSON.stringify({ tasks: taskList }));
        localStorage.setItem('lm40b_done', JSON.stringify(Array.from(doneTasks.values())));
        localStorage.setItem('lm40b_synced', JSON.stringify(Array.from(syncedKeys)));
        localStorage.setItem('lm40b_records', JSON.stringify(records));
    }

    function bindEvents() {
        document.querySelectorAll('.dim-btn').forEach(btn => {
            btn.addEventListener('click', () => selectDim(btn.dataset.dim));
        });
        document.getElementById('btn-connect').addEventListener('click', connectBluetooth);
        document.getElementById('btn-select-room').addEventListener('click', () => showSelectPage('bldg'));
        document.getElementById('btn-settings').addEventListener('click', showSettingsPage);
        document.getElementById('btn-back-select').addEventListener('click', navigateSelectBack);
        document.getElementById('btn-back-measure').addEventListener('click', stopMeasurement);
        document.getElementById('btn-back-settings').addEventListener('click', () => showPage('home-page'));
        document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromForm);
        document.getElementById('btn-sync-now').addEventListener('click', syncNow);

        // 设置表单默认值
        document.getElementById('setting-repo').value = settings.repo;
        document.getElementById('setting-task-path').value = settings.taskPath;
        document.getElementById('setting-progress-path').value = settings.progressPath;
        document.getElementById('setting-branch').value = settings.branch;
        document.getElementById('setting-token').value = settings.token;
    }

    function showPage(id) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    }

    // ===== 首页 =====
    function renderHome() {
        const huCount = countHuProgress();
        const pct = huCount.total > 0 ? Math.round(huCount.done / huCount.total * 100) : 0;
        setStatus(`任务清单加载完成 · 共 ${huCount.total} 户 · 已完成 ${huCount.done} 户（${pct}%）`);
    }

    function setStatus(text) {
        document.getElementById('status-text').textContent = text;
    }

    function selectDim(dim) {
        selectedDim = dim;
        document.querySelectorAll('.dim-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.dim === dim);
        });
        const label = dim === 'kjjs' ? '开间进深' : '顶板极差';
        setStatus(`本次测量：${label}`);
    }

    function countHuProgress() {
        const total = new Set();
        const done = new Set();
        taskList.forEach(t => {
            const huKey = `${t.bldg}|${t.floor}|${t.hu}`;
            total.add(huKey);
            if (t.status === '已测' || doneTasks.has(taskKey(t))) {
                done.add(huKey);
            }
        });
        return { total: total.size, done: done.size };
    }

    // ===== GitHub API =====
    async function githubRequest(path, opts = {}) {
        const url = `https://api.github.com/repos/${settings.repo}/contents/${path}?ref=${settings.branch}`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `token ${settings.token}`,
                'Accept': 'application/vnd.github+json'
            },
            ...opts
        });
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        return res.json();
    }

    async function downloadFile(path) {
        try {
            const data = await githubRequest(path);
            const content = data.content.replace(/\s/g, '');
            const decoded = atob(content);
            return { content: decoded, sha: data.sha };
        } catch (e) {
            console.warn('download failed', path, e);
            return null;
        }
    }

    async function uploadFile(path, content, message, sha) {
        const body = {
            message,
            content: btoa(unescape(encodeURIComponent(content))),
            branch: settings.branch
        };
        if (sha) body.sha = sha;
        const res = await fetch(`https://api.github.com/repos/${settings.repo}/contents/${path}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${settings.token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return res.ok;
    }

    async function loadTasks() {
        setStatus('正在加载任务清单…');
        try {
            const remote = await downloadFile(settings.taskPath);
            if (remote) {
                const obj = JSON.parse(remote.content);
                taskList = obj.tasks || [];
                applyDoneStatuses();
                saveToLocalStorage();
                renderHome();
                setStatus('任务清单已更新');
                await loadProgress();
                return;
            }
        } catch (e) {
            console.warn('load tasks remote failed', e);
        }
        // 使用本地缓存
        if (taskList.length > 0) {
            applyDoneStatuses();
            renderHome();
            setStatus('使用本地缓存任务清单');
            await loadProgress();
        } else {
            setStatus('任务清单加载失败');
        }
    }

    async function loadProgress() {
        try {
            const remote = await downloadFile(settings.progressPath);
            if (remote) {
                const obj = JSON.parse(remote.content);
                const arr = obj.done || [];
                arr.forEach(o => {
                    const key = taskKey(o);
                    if (!doneTasks.has(key)) {
                        doneTasks.set(key, o);
                    }
                });
                applyDoneStatuses();
                saveToLocalStorage();
                setStatus('进度已同步');
            }
        } catch (e) {
            console.warn('load progress failed', e);
        }
    }

    function applyDoneStatuses() {
        taskList.forEach(t => {
            if (doneTasks.has(taskKey(t))) {
                t.status = '已测';
            }
        });
    }

    async function syncNow() {
        setStatus('正在同步…');
        const msgEl = document.getElementById('settings-msg');
        if (msgEl) msgEl.textContent = '正在同步…';
        try {
            await loadProgress();
            const hasNew = Array.from(doneTasks.keys()).some(k => !syncedKeys.has(k));
            if (!hasNew) {
                setStatus('无新数据，无需同步');
                if (msgEl) msgEl.textContent = '无新数据，无需同步';
                return;
            }
            const content = JSON.stringify({
                version: '2026-11-08',
                updatedAt: new Date().toLocaleString('zh-CN'),
                done: Array.from(doneTasks.values())
            }, null, 2);
            const remote = await downloadFile(settings.progressPath);
            const ok = await uploadFile(settings.progressPath, content, '更新测量进度 ' + new Date().toLocaleString('zh-CN'), remote?.sha);
            if (ok) {
                syncedKeys = new Set(Array.from(doneTasks.keys()));
                saveToLocalStorage();
                setStatus('同步成功');
                if (msgEl) msgEl.textContent = '同步成功';
            } else {
                setStatus('同步失败');
                if (msgEl) msgEl.textContent = '同步失败';
            }
        } catch (e) {
            console.error('sync failed', e);
            setStatus('同步失败：' + e.message);
            if (msgEl) msgEl.textContent = '同步失败：' + e.message;
        }
    }

    // ===== 选择房间 =====
    let selectStack = { view: 'bldg', bldg: '', floor: '', hu: '' };

    function showSelectPage(view) {
        if (!selectedDim) {
            alert('请先在首页选择测量维度');
            return;
        }
        selectStack.view = view;
        renderSelectPage();
        showPage('select-page');
    }

    function navigateSelectBack() {
        if (selectStack.view === 'floor') {
            selectStack.view = 'bldg';
            selectStack.bldg = '';
        } else if (selectStack.view === 'hu') {
            selectStack.view = 'floor';
            selectStack.floor = '';
        } else if (selectStack.view === 'room') {
            selectStack.view = 'hu';
            selectStack.hu = '';
        } else {
            showPage('home-page');
            return;
        }
        renderSelectPage();
    }

    function renderSelectPage() {
        const view = selectStack.view;
        const listEl = document.getElementById('select-list');
        listEl.innerHTML = '';

        const dimTasks = taskList.filter(t => itemDim(t.item) === selectedDim);

        if (view === 'bldg') {
            document.getElementById('select-title').textContent = '选择楼栋 · ' + dimLabel(selectedDim);
            const bldgs = groupBy(dimTasks, 'bldg');
            renderList(bldgs, (bldg, items) => {
                const done = items.filter(t => t.status === '已测').length;
                const pct = items.length ? Math.round(done / items.length * 100) : 0;
                createCard(bldg, items[0].huxing || '', `${done}/${items.length}`, `${pct}%`, () => {
                    selectStack.bldg = bldg;
                    selectStack.view = 'floor';
                    renderSelectPage();
                });
            });
            const total = dimTasks.length;
            const done = dimTasks.filter(t => t.status === '已测').length;
            document.getElementById('select-stats').textContent = `全部楼栋 · 共 ${total} 个 · 已测 ${done} · 待测 ${total - done}`;
        } else if (view === 'floor') {
            document.getElementById('select-title').textContent = selectStack.bldg + ' · 选择楼层';
            const floors = groupBy(dimTasks.filter(t => t.bldg === selectStack.bldg), 'floor');
            renderList(floors, (floor, items) => {
                const done = items.filter(t => t.status === '已测').length;
                const pct = items.length ? Math.round(done / items.length * 100) : 0;
                createCard(floor + '层', '', `${done}/${items.length}`, `${pct}%`, () => {
                    selectStack.floor = String(floor);
                    selectStack.view = 'hu';
                    renderSelectPage();
                });
            });
            const bldgItems = dimTasks.filter(t => t.bldg === selectStack.bldg);
            const done = bldgItems.filter(t => t.status === '已测').length;
            document.getElementById('select-stats').textContent = `${selectStack.bldg} · 共 ${bldgItems.length} 个 · 已测 ${done} · 待测 ${bldgItems.length - done}`;
        } else if (view === 'hu') {
            document.getElementById('select-title').textContent = `${selectStack.bldg} ${selectStack.floor}层 · 选择户号`;
            const hus = groupBy(dimTasks.filter(t => t.bldg === selectStack.bldg && String(t.floor) === selectStack.floor), 'hu');
            renderList(hus, (hu, items) => {
                const done = items.filter(t => t.status === '已测').length;
                const pct = items.length ? Math.round(done / items.length * 100) : 0;
                createCard(hu + '户', '', `${done}/${items.length}`, `${pct}%`, () => {
                    selectStack.hu = String(hu);
                    selectStack.view = 'room';
                    renderSelectPage();
                });
            });
            const floorItems = dimTasks.filter(t => t.bldg === selectStack.bldg && String(t.floor) === selectStack.floor);
            const done = floorItems.filter(t => t.status === '已测').length;
            document.getElementById('select-stats').textContent = `${selectStack.bldg} ${selectStack.floor}层 · 共 ${floorItems.length} 个 · 已测 ${done} · 待测 ${floorItems.length - done}`;
        } else if (view === 'room') {
            document.getElementById('select-title').textContent = `${selectStack.bldg} ${selectStack.floor}层 ${selectStack.hu}户 · 选择房间`;
            const rooms = [...new Set(dimTasks
                .filter(t => t.bldg === selectStack.bldg && String(t.floor) === selectStack.floor && String(t.hu) === selectStack.hu)
                .map(t => t.room))];
            rooms.forEach(room => {
                const roomTasks = dimTasks.filter(t => t.bldg === selectStack.bldg && String(t.floor) === selectStack.floor && String(t.hu) === selectStack.hu && t.room === room);
                const done = roomTasks.every(t => t.status === '已测');
                createCard(room, done ? '已测' : '待测', '', done ? '已测' : '待测', () => {
                    startMeasurement(selectStack.bldg, parseInt(selectStack.floor), parseInt(selectStack.hu), room);
                });
            });
            const huItems = dimTasks.filter(t => t.bldg === selectStack.bldg && String(t.floor) === selectStack.floor && String(t.hu) === selectStack.hu);
            const done = huItems.filter(t => t.status === '已测').length;
            document.getElementById('select-stats').textContent = `${selectStack.bldg} ${selectStack.floor}层 ${selectStack.hu}户 · 共 ${huItems.length} 个 · 已测 ${done} · 待测 ${huItems.length - done}`;
        }

        function renderList(map, callback) {
            Array.from(map.entries()).forEach(([key, items]) => callback(key, items));
        }

        function createCard(title, sub, count, pct, onClick) {
            const div = document.createElement('div');
            div.className = 'list-item';
            div.innerHTML = `
                <div class="list-item-left">
                    <div class="list-item-title">${title}</div>
                    ${sub ? `<div class="list-item-sub">${sub}</div>` : ''}
                </div>
                <div class="list-item-right">
                    ${count ? `<div class="list-item-count">${count}</div>` : ''}
                    ${pct ? `<div class="list-item-pct">${pct}</div>` : ''}
                </div>
            `;
            div.addEventListener('click', onClick);
            listEl.appendChild(div);
        }
    }

    function groupBy(arr, key) {
        const map = new Map();
        arr.forEach(item => {
            const val = item[key];
            if (!map.has(val)) map.set(val, []);
            map.get(val).push(item);
        });
        return map;
    }

    // ===== 测量页面 =====
    function startMeasurement(bldg, floor, hu, room) {
        const items = selectedDim === 'kjjs'
            ? ['开间一', '开间二', '进深一', '进深二']
            : ['顶板极差1', '顶板极差2', '顶板极差3', '顶板极差4', '顶板极差5'];
        const labels = selectedDim === 'kjjs'
            ? ['第一尺', '第二尺', '第三尺', '第四尺']
            : ['第一点', '第二点', '第三点', '第四点', '第五点'];

        let itemIndex = 0;
        for (let i = 0; i < items.length; i++) {
            const key = taskKey({ bldg, floor, hu, room, item: items[i] });
            if (!doneTasks.has(key)) {
                itemIndex = i;
                break;
            }
        }

        measureState = { bldg, floor, hu, room, items, labels, itemIndex };
        renderMeasurementPage();
        showPage('measure-page');
        speak(`${bldg}-${floor}层-${hu}户，${room}`);
    }

    function stopMeasurement() {
        measureState = null;
        showPage('home-page');
        renderHome();
    }

    function renderMeasurementPage() {
        if (!measureState) return;
        const { bldg, floor, hu, room, items, labels, itemIndex } = measureState;
        document.getElementById('measure-hu').textContent = `${bldg}-${floor}层-${hu}户`;
        document.getElementById('measure-room').textContent = room;
        const listEl = document.getElementById('measure-list');
        listEl.innerHTML = '';

        items.forEach((item, i) => {
            const key = taskKey({ bldg, floor, hu, room, item });
            const done = doneTasks.get(key);
            const isCurrent = i === itemIndex;
            const row = document.createElement('div');
            row.className = 'measure-row' + (isCurrent ? ' current' : '') + (done ? ' done' : '');
            row.innerHTML = `
                <div class="measure-label">${labels[i]}</div>
                <div class="measure-value">${done ? done.meters.toFixed(3) + ' m' : '—'}</div>
            `;
            if (done) {
                const del = document.createElement('button');
                del.className = 'btn-delete';
                del.textContent = '删除';
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteItem(item);
                });
                row.appendChild(del);
            }
            row.addEventListener('click', () => {
                measureState.itemIndex = i;
                renderMeasurementPage();
            });
            listEl.appendChild(row);
        });

        updateCountView();
    }

    function deleteItem(item) {
        if (!measureState) return;
        const { bldg, floor, hu, room } = measureState;
        const key = taskKey({ bldg, floor, hu, room, item });
        doneTasks.delete(key);
        records = records.filter(r => !r.room.endsWith(`-${item}`) || !r.room.startsWith(`${bldg}-${floor}F-${hu}户-${room}-`));
        const t = taskList.find(x => x.bldg === bldg && x.floor === floor && x.hu === hu && x.room === room && x.item === item);
        if (t) t.status = '';
        saveToLocalStorage();
        renderMeasurementPage();
    }

    function handleMeasurement(meters) {
        if (!measureState) return;
        const { bldg, floor, hu, room, items, labels, itemIndex } = measureState;
        if (itemIndex >= items.length) return;
        const item = items[itemIndex];
        const label = labels[itemIndex];
        const key = taskKey({ bldg, floor, hu, room, item });

        doneTasks.set(key, { bldg, floor, hu, room, item, meters: round3(meters) });
        records.push({ room: `${bldg}-${floor}F-${hu}户-${room}-${item}`, meters: round3(meters), time: Date.now() });

        const t = taskList.find(x => x.bldg === bldg && x.floor === floor && x.hu === hu && x.room === room && x.item === item);
        if (t) t.status = '已测';

        saveToLocalStorage();
        speak(`${label} ${meters.toFixed(3)} 米`);

        measureState.itemIndex++;
        renderMeasurementPage();

        if (measureState.itemIndex >= items.length) {
            speak('本房间测量完成');
            setTimeout(() => {
                syncNow().then(() => {
                    const next = findNextPendingRoom();
                    if (next) {
                        startMeasurement(next.bldg, next.floor, next.hu, next.room);
                    } else {
                        speak('本维度全部测完');
                        stopMeasurement();
                    }
                });
            }, 1200);
        }
    }

    function findNextPendingRoom() {
        if (!measureState) return null;
        const { bldg, floor, hu } = measureState;
        const dimTasks = taskList.filter(t => itemDim(t.item) === selectedDim);

        // 同户下一个房间
        for (const t of dimTasks) {
            if (t.bldg === bldg && t.floor === floor && t.hu === hu && t.status !== '已测') {
                return t;
            }
        }
        // 同楼层下一户
        let nextHu = hu + 1;
        while (true) {
            let huExists = false;
            let candidate = null;
            for (const t of dimTasks) {
                if (t.bldg === bldg && t.floor === floor && t.hu === nextHu) {
                    huExists = true;
                    if (t.status !== '已测') { candidate = t; break; }
                }
            }
            if (candidate) return candidate;
            if (!huExists) break;
            nextHu++;
        }
        // 下一楼层第一户
        let nextFloor = floor + 1;
        while (true) {
            let floorExists = false;
            let candidate = null;
            for (const t of dimTasks) {
                if (t.bldg === bldg && t.floor === nextFloor) {
                    floorExists = true;
                    if (t.hu === 1 && t.status !== '已测') { candidate = t; break; }
                }
            }
            if (candidate) return candidate;
            if (!floorExists) break;
            nextFloor++;
        }
        return null;
    }

    function updateCountView() {
        if (!measureState) return;
        const { bldg, floor, hu, room } = measureState;
        const n = records.filter(r => r.room.startsWith(`${bldg}-${floor}F-${hu}户-${room}-`)).length;
        document.getElementById('count-view').textContent = `当前房间已测 ${n} 条`;
    }

    // ===== 蓝牙 =====
    async function connectBluetooth() {
        if (!navigator.bluetooth) {
            alert('此浏览器不支持蓝牙，请用 Chrome 或 Edge');
            return;
        }
        try {
            setStatus('正在请求蓝牙设备…');
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [SVC_FFB0] }]
            });
            bluetoothDevice = device;
            setStatus('正在连接…');
            const server = await device.gatt.connect();
            bluetoothServer = server;
            const service = await server.getPrimaryService(SVC_FFB0);
            const characteristic = await service.getCharacteristic(CHR_FFB2);
            bluetoothChar = characteristic;
            await characteristic.startNotifications();
            characteristic.addEventListener('characteristicvaluechanged', handleBluetoothData);
            setStatus('已连接测距仪');
            document.getElementById('caption').textContent = '已连接，按测量键开始';
        } catch (e) {
            console.error('bluetooth error', e);
            setStatus('蓝牙连接失败：' + e.message);
        }
    }

    function handleBluetoothData(event) {
        const value = event.target.value;
        const data = new Uint8Array(value.buffer);
        if (data.length >= 17 && data[0] === 0x41 && data[1] === 0x54 && data[2] === 0x44 && data[16] === 0x23) {
            let sum = 0;
            for (let i = 0; i < 15; i++) sum = (sum + data[i]) & 0xFF;
            if (sum !== data[15]) return;
            const raw = (data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6];
            const meters = raw / 10000.0;
            const rounded = round3(meters);
            document.getElementById('reading').textContent = rounded.toFixed(3);
            if (measureState && measureState.itemIndex < measureState.items.length) {
                document.getElementById('caption').textContent = `已记入 ${measureState.labels[measureState.itemIndex]}`;
                handleMeasurement(rounded);
            } else {
                document.getElementById('caption').textContent = '请先选择房间';
            }
        }
    }

    // ===== 设置 =====
    function showSettingsPage() {
        showPage('settings-page');
    }

    function saveSettingsFromForm() {
        settings.repo = document.getElementById('setting-repo').value.trim();
        settings.taskPath = document.getElementById('setting-task-path').value.trim();
        settings.progressPath = document.getElementById('setting-progress-path').value.trim();
        settings.branch = document.getElementById('setting-branch').value.trim();
        settings.token = document.getElementById('setting-token').value.trim();
        saveSettings();
        document.getElementById('settings-msg').textContent = '设置已保存';
    }

    // ===== 工具函数 =====
    function taskKey(t) {
        return `${t.bldg}|${t.floor}|${t.hu}|${t.room}|${t.item}`;
    }

    function itemDim(item) {
        if (item.startsWith('开间') || item.startsWith('进深')) return 'kjjs';
        if (item.startsWith('顶板极差')) return 'jg';
        return '';
    }

    function dimLabel(dim) {
        return dim === 'kjjs' ? '开间进深' : '顶板极差';
    }

    function round3(v) {
        return Math.round(v * 1000) / 1000;
    }

    function speak(text) {
        if ('speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'zh-CN';
            u.rate = 1.1;
            window.speechSynthesis.speak(u);
        }
    }
})();
