import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { InstallJob, SourceId, StoreApp, StoreState } from '../../../shared/store-types';
import { INITIAL_STORE_STATE } from '../../../shared/store-types';
import { onIndexUpdated, onInstalled, onJob } from '../../hooks/storeEvents';
import { AppCard } from './AppCard';
import { AppDetail } from './AppDetail';
import { InstallQueue } from './InstallQueue';
import { PlayFrame } from './PlayFrame';

type Filter = 'all' | SourceId;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fdroid', label: 'F-Droid' },
  { id: 'play', label: 'Play' },
  { id: 'local', label: 'Local' },
];

/** Long enough that typing doesn't re-rank on every keystroke, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 180;

export function StoreView() {
  const [state, setState] = useState<StoreState>(INITIAL_STORE_STATE);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StoreApp[] | null>(null);
  const [selected, setSelected] = useState<StoreApp | null>(null);
  const [jobs, setJobs] = useState<InstallJob[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [dropping, setDropping] = useState(false);
  const searchSeq = useRef(0);

  const refreshInstalled = useCallback(() => {
    void window.openEmu.listApps().then((apps) => {
      setInstalled(new Set(apps.map((app) => app.packageName)));
    });
  }, []);

  useEffect(() => {
    void window.openEmu.storeState().then(setState);
    void window.openEmu.storeProbeGuest().then(setState);
    void window.openEmu.storeJobs().then(setJobs);
    refreshInstalled();

    const offJob = onJob((job) => {
      setJobs((prev) => {
        const index = prev.findIndex((candidate) => candidate.id === job.id);
        if (index === -1) return [job, ...prev];
        const next = [...prev];
        next[index] = job;
        return next;
      });
    });
    const offInstalled = onInstalled(() => refreshInstalled());
    const offIndex = onIndexUpdated(setState);

    return () => {
      offJob();
      offInstalled();
      offIndex();
    };
  }, [refreshInstalled]);

  // Debounced search. The sequence guard drops a slow response that lands after a newer one —
  // otherwise a laggy query can overwrite the results for the text now in the box.
  useEffect(() => {
    if (filter === 'play') return;
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void window.openEmu.storeSearch(query, filter === 'all' ? null : filter, 60).then((next) => {
        if (seq === searchSeq.current) setResults(next);
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, filter, state.indexReady, state.guestSdk]);

  const jobFor = useMemo(() => {
    const map = new Map<string, InstallJob>();
    // Newest first, so a retry supersedes the failed attempt it replaced.
    for (const job of [...jobs].reverse()) map.set(`${job.source}:${job.packageName}`, job);
    return map;
  }, [jobs]);

  const visibleJobs = jobs.filter((job) => !dismissed.includes(job.id));

  function install(app: StoreApp, versionCode: number | null = null) {
    void window.openEmu.storeInstall(app.source, app.packageName, versionCode).then((job) => {
      if (job) setJobs((prev) => (prev.some((c) => c.id === job.id) ? prev : [job, ...prev]));
    });
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDropping(false);

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.openEmu.pathForFile(file))
      .filter((filePath): filePath is string => filePath !== null && filePath.toLowerCase().endsWith('.apk'));

    if (paths.length === 0) return;
    await Promise.all(paths.map((filePath) => window.openEmu.storeImportApk(filePath)));
    setFilter('local');
    setQuery('');
  }

  function recheckGuest() {
    void window.openEmu.storeProbeGuest(true).then(setState);
  }

  const tiles = (results ?? []).map((app) => (
    <AppCard
      key={app.id}
      app={app}
      job={jobFor.get(`${app.source}:${app.packageName}`) ?? null}
      guestSdk={state.guestSdk}
      installed={installed.has(app.packageName)}
      onOpen={setSelected}
      onInstall={(target) => install(target)}
    />
  ));

  return (
    <div
      className={`store ${dropping ? 'store-dropping' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => void handleDrop(event)}
    >
      <div className="store-bar">
        <div className="store-search-wrap">
          <input
            className="store-search"
            type="search"
            placeholder={filter === 'play' ? 'Search happens in the Play tab below' : 'Search apps…'}
            value={query}
            disabled={filter === 'play'}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
          />
        </div>
        <div className="source-chips">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={filter === entry.id ? 'chip on' : 'chip'}
              onClick={() => {
                setFilter(entry.id);
                setSelected(null);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {/* The Play frame sizes itself to the guest and must not sit inside a scroller — the
          mirrored screen would then be taller than the pane and scroll instead of fitting. */}
      <div className={`store-body ${filter === 'play' ? 'store-body-play' : ''}`}>
        {filter === 'play' ? (
          <PlayFrame state={state} onRecheck={recheckGuest} />
        ) : selected ? (
          <AppDetail
            app={selected}
            job={jobFor.get(`${selected.source}:${selected.packageName}`) ?? null}
            guestSdk={state.guestSdk}
            installed={installed.has(selected.packageName)}
            onBack={() => setSelected(null)}
            onInstall={install}
          />
        ) : (
          <>
            {results === null && (
              <div className="empty-state">
                <p className="empty-title">Loading the catalogue…</p>
                <p className="store-note">This happens once, then search is local.</p>
              </div>
            )}
            {results !== null && results.length === 0 && (
              <div className="empty-state">
                <p className="empty-title">{state.indexReady ? 'Nothing matched' : 'Fetching the catalogue'}</p>
                <p className="store-note">
                  {state.indexReady
                    ? 'Try a different name, or drop an APK onto this window to install one directly.'
                    : 'The F-Droid index is downloaded once, then searched locally.'}
                </p>
              </div>
            )}
            <div className="store-grid">{tiles}</div>
          </>
        )}
      </div>

      <InstallQueue jobs={visibleJobs} onDismiss={(id) => setDismissed((prev) => [...prev, id])} />

      <div className="store-status">
        {state.indexReady && <span>{state.indexAppCount.toLocaleString()} apps</span>}
        <span>{state.guestSdk === null ? 'guest not reachable' : `guest API ${state.guestSdk}`}</span>
        <button type="button" className="store-link" onClick={() => void window.openEmu.storeRefreshIndex(true).then(setState)}>
          Refresh catalogue
        </button>
      </div>
    </div>
  );
}
