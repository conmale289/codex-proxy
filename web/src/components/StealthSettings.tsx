import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useStealthSettings } from "../../../shared/hooks/use-stealth-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

export function StealthSettings() {
  const t = useT();
  const settings = useSettings();
  const stealth = useStealthSettings(settings.apiKey);

  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftInterval, setDraftInterval] = useState<string | null>(null);
  const [draftMaxConcurrent, setDraftMaxConcurrent] = useState<string | null>(null);
  const [draftInstallId, setDraftInstallId] = useState<boolean | null>(null);
  const [draftJitter, setDraftJitter] = useState<boolean | null>(null);
  const [draftWarn, setDraftWarn] = useState<string | null>(null);
  const [draftThrottle, setDraftThrottle] = useState<string | null>(null);
  const [draftPause, setDraftPause] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const currentEnabled = stealth.data?.enabled ?? false;
  const currentInterval = stealth.data?.min_request_interval_ms ?? 3000;
  const currentMaxConcurrent = stealth.data?.max_concurrent_per_account ?? 1;
  const currentInstallId = stealth.data?.per_account_installation_id ?? true;
  const currentJitter = stealth.data?.humanlike_jitter ?? true;
  const currentWarn = stealth.data?.hourly_request_warn ?? 100;
  const currentThrottle = stealth.data?.hourly_request_throttle ?? 200;
  const currentPause = stealth.data?.hourly_request_pause ?? 500;

  const displayEnabled = draftEnabled ?? currentEnabled;
  const displayInterval = draftInterval ?? String(currentInterval);
  const displayMaxConcurrent = draftMaxConcurrent ?? String(currentMaxConcurrent);
  const displayInstallId = draftInstallId ?? currentInstallId;
  const displayJitter = draftJitter ?? currentJitter;
  const displayWarn = draftWarn ?? String(currentWarn);
  const displayThrottle = draftThrottle ?? String(currentThrottle);
  const displayPause = draftPause ?? String(currentPause);

  const isDirty =
    draftEnabled !== null ||
    draftInterval !== null ||
    draftMaxConcurrent !== null ||
    draftInstallId !== null ||
    draftJitter !== null ||
    draftWarn !== null ||
    draftThrottle !== null ||
    draftPause !== null;

  const handleSave = useCallback(async () => {
    const patch: Record<string, unknown> = {};
    if (draftEnabled !== null) patch.enabled = draftEnabled;
    if (draftInterval !== null) patch.min_request_interval_ms = parseInt(draftInterval, 10);
    if (draftMaxConcurrent !== null) patch.max_concurrent_per_account = parseInt(draftMaxConcurrent, 10);
    if (draftInstallId !== null) patch.per_account_installation_id = draftInstallId;
    if (draftJitter !== null) patch.humanlike_jitter = draftJitter;
    if (draftWarn !== null) patch.hourly_request_warn = parseInt(draftWarn, 10);
    if (draftThrottle !== null) patch.hourly_request_throttle = parseInt(draftThrottle, 10);
    if (draftPause !== null) patch.hourly_request_pause = parseInt(draftPause, 10);

    await stealth.save(patch);
    setDraftEnabled(null);
    setDraftInterval(null);
    setDraftMaxConcurrent(null);
    setDraftInstallId(null);
    setDraftJitter(null);
    setDraftWarn(null);
    setDraftThrottle(null);
    setDraftPause(null);
  }, [draftEnabled, draftInterval, draftMaxConcurrent, draftInstallId, draftJitter, draftWarn, draftThrottle, draftPause, stealth]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("stealthSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <p class="text-xs text-slate-400 dark:text-text-dim">{t("stealthHint")}</p>

          {/* Enable toggle */}
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                id="stealth-enabled"
                checked={displayEnabled}
                onChange={(e) => setDraftEnabled((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
              />
              <label for="stealth-enabled" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
                {t("stealthEnabled")}
              </label>
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("stealthEnabledHint")}</p>
          </div>

          {/* Timing settings */}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
                {t("stealthInterval")}
              </label>
              <p class="text-xs text-slate-400 dark:text-text-dim">{t("stealthIntervalHint")}</p>
              <input
                type="number"
                min="0"
                step="500"
                class={`${inputCls} max-w-[160px]`}
                value={displayInterval}
                onInput={(e) => setDraftInterval((e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
                {t("stealthMaxConcurrent")}
              </label>
              <p class="text-xs text-slate-400 dark:text-text-dim">{t("stealthMaxConcurrentHint")}</p>
              <input
                type="number"
                min="1"
                max="10"
                class={`${inputCls} max-w-[160px]`}
                value={displayMaxConcurrent}
                onInput={(e) => setDraftMaxConcurrent((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          {/* Toggles */}
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                id="stealth-install-id"
                checked={displayInstallId}
                onChange={(e) => setDraftInstallId((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
              />
              <label for="stealth-install-id" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
                {t("stealthInstallId")}
              </label>
              <span class="text-xs text-slate-400 dark:text-text-dim">{t("stealthInstallIdHint")}</span>
            </div>

            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                id="stealth-jitter"
                checked={displayJitter}
                onChange={(e) => setDraftJitter((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
              />
              <label for="stealth-jitter" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
                {t("stealthJitter")}
              </label>
              <span class="text-xs text-slate-400 dark:text-text-dim">{t("stealthJitterHint")}</span>
            </div>
          </div>

          {/* Hourly limits */}
          <div>
            <p class="text-xs font-semibold text-slate-700 dark:text-text-main mb-2">{t("stealthHourlyLimits")}</p>
            <p class="text-xs text-slate-400 dark:text-text-dim mb-3">{t("stealthHourlyLimitsHint")}</p>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div class="space-y-1.5">
                <label class="text-xs text-slate-600 dark:text-text-dim">{t("stealthWarn")}</label>
                <input
                  type="number"
                  min="0"
                  class={`${inputCls} max-w-[140px]`}
                  value={displayWarn}
                  onInput={(e) => setDraftWarn((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-slate-600 dark:text-text-dim">{t("stealthThrottle")}</label>
                <input
                  type="number"
                  min="0"
                  class={`${inputCls} max-w-[140px]`}
                  value={displayThrottle}
                  onInput={(e) => setDraftThrottle((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-slate-600 dark:text-text-dim">{t("stealthPause")}</label>
                <input
                  type="number"
                  min="0"
                  class={`${inputCls} max-w-[140px]`}
                  value={displayPause}
                  onInput={(e) => setDraftPause((e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
          </div>

          {/* Save */}
          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={stealth.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !stealth.saving
                  ? "bg-primary-action text-white hover:bg-primary-action-hover cursor-pointer"
                  : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
              }`}
            >
              {stealth.saving ? "..." : t("submit")}
            </button>
            {stealth.saved && (
              <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("stealthSaved")}</span>
            )}
            {stealth.error && (
              <span class="text-xs font-medium text-red-500">{stealth.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
