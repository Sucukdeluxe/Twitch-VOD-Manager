function run() {
    const failures = [];
    const assert = (condition, message) => {
        if (!condition) failures.push(message);
    };

    // ---- Test 1: parseDuration summation ----
    function parseDuration(duration) {
        let seconds = 0;
        const hours = duration.match(/(\d+)h/);
        const minutes = duration.match(/(\d+)m/);
        const secs = duration.match(/(\d+)s/);
        if (hours) seconds += parseInt(hours[1]) * 3600;
        if (minutes) seconds += parseInt(minutes[1]) * 60;
        if (secs) seconds += parseInt(secs[1]);
        return seconds;
    }

    const vods = [
        { duration_str: '2h30m0s' },
        { duration_str: '1h45m30s' }
    ];
    const totalDuration = vods.reduce((sum, v) => sum + parseDuration(v.duration_str), 0);
    assert(totalDuration === 15330, `Duration sum: expected 15330, got ${totalDuration}`);

    // ---- Test 2: Chronological sort by ISO timestamp ----
    const items = [
        { date: '2026-03-01T18:00:00Z', title: 'Evening' },
        { date: '2026-03-01T16:00:00Z', title: 'Afternoon' },
        { date: '2026-03-02T10:00:00Z', title: 'Next Day' }
    ];
    const sorted = [...items].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    assert(sorted[0].title === 'Afternoon', `Sort[0]: expected Afternoon, got ${sorted[0].title}`);
    assert(sorted[1].title === 'Evening', `Sort[1]: expected Evening, got ${sorted[1].title}`);
    assert(sorted[2].title === 'Next Day', `Sort[2]: expected Next Day, got ${sorted[2].title}`);

    // ---- Test 3: Same day, different times ----
    const sameDay = [
        { date: '2026-03-01T18:30:00Z', title: 'Later' },
        { date: '2026-03-01T16:15:00Z', title: 'Earlier' }
    ];
    const sortedSameDay = [...sameDay].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    assert(sortedSameDay[0].title === 'Earlier', `SameDay[0]: expected Earlier, got ${sortedSameDay[0].title}`);
    assert(sortedSameDay[1].title === 'Later', `SameDay[1]: expected Later, got ${sortedSameDay[1].title}`);

    // ---- Test 4: Merge group title generation ----
    function makeMergeTitle(items, isEnglish) {
        if (items.length === 2) return `Merge: ${items[0].title} + ${items[1].title}`;
        return `Merge: ${items[0].title} + ${items.length - 1} ${isEnglish ? 'more' : 'weitere'}`;
    }
    assert(
        makeMergeTitle([{ title: 'A' }, { title: 'B' }], true) === 'Merge: A + B',
        'Title 2 items failed'
    );
    assert(
        makeMergeTitle([{ title: 'A' }, { title: 'B' }, { title: 'C' }], false) === 'Merge: A + 2 weitere',
        'Title 3 items DE failed'
    );
    assert(
        makeMergeTitle([{ title: 'A' }, { title: 'B' }, { title: 'C' }], true) === 'Merge: A + 2 more',
        'Title 3 items EN failed'
    );

    // ---- Test 5: Progress weighting (70/20/10) ----
    const totalSec = 10800; // 180min
    const vod1Dur = 3600;   // 60min
    const vod2Dur = 7200;   // 120min
    const vod1Weight = vod1Dur / totalSec;
    const vod2Weight = vod2Dur / totalSec;
    const priorWeight = vod1Weight;
    const vodProgress = 50;
    const overallProgress = (priorWeight + vod2Weight * (vodProgress / 100)) * 70;
    assert(
        Math.abs(overallProgress - 46.67) < 0.1,
        `Progress weighting: expected ~46.67, got ${overallProgress}`
    );

    // ---- Test 6: Split part count ----
    const partMinutes = 60;
    const mergedDuration = 15330; // 4h15m30s
    const numParts = Math.ceil(mergedDuration / (partMinutes * 60));
    assert(numParts === 5, `Split parts: expected 5, got ${numParts}`);

    // ---- Test 7: Object.keys explicit sort for downloadedFiles ----
    const downloadedFiles = { 2: '/path/c.mp4', 0: '/path/a.mp4', 1: '/path/b.mp4' };
    const sortedPaths = Object.keys(downloadedFiles)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => downloadedFiles[Number(k)]);
    assert(sortedPaths[0] === '/path/a.mp4', `Sort files[0]: expected a.mp4, got ${sortedPaths[0]}`);
    assert(sortedPaths[1] === '/path/b.mp4', `Sort files[1]: expected b.mp4, got ${sortedPaths[1]}`);
    assert(sortedPaths[2] === '/path/c.mp4', `Sort files[2]: expected c.mp4, got ${sortedPaths[2]}`);

    // ---- Test 8: FFmpeg split args order (-ss before -i) ----
    function buildSplitArgs(startSec, inputFile, durationSec) {
        const formatDur = (s) => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
        };
        return ['-ss', formatDur(startSec), '-i', inputFile, '-t', formatDur(durationSec), '-c', 'copy', '-y', 'out.mp4'];
    }
    const args = buildSplitArgs(3600, 'input.mp4', 3600);
    const ssIndex = args.indexOf('-ss');
    const iIndex = args.indexOf('-i');
    assert(ssIndex < iIndex, `FFmpeg args: -ss (${ssIndex}) must be before -i (${iIndex})`);

    // ---- Test 9: ensureUniqueFilename pattern ----
    function ensureUnique(base, ext, existingFiles) {
        let candidate = base + ext;
        if (!existingFiles.includes(candidate)) return candidate;
        let counter = 1;
        while (existingFiles.includes(candidate)) {
            candidate = `${base}_${counter}${ext}`;
            counter++;
        }
        return candidate;
    }
    assert(ensureUnique('video', '.mp4', []) === 'video.mp4', 'Unique: no conflict');
    assert(ensureUnique('video', '.mp4', ['video.mp4']) === 'video_1.mp4', 'Unique: one conflict');
    assert(ensureUnique('video', '.mp4', ['video.mp4', 'video_1.mp4']) === 'video_2.mp4', 'Unique: two conflicts');

    // ---- Results ----
    if (failures.length > 0) {
        console.error(`FAIL: ${failures.length} test(s) failed:`);
        failures.forEach(f => console.error(`  - ${f}`));
        process.exit(1);
    }

    console.log('All merge-split logic tests passed!');
    process.exit(0);
}

run();
