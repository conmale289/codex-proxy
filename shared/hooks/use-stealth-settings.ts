import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";

export interface StealthSettingsData {
  enabled: boolean;
  min_request_interval_ms: number;
  max_concurrent_per_account: number;
  per_account_installation_id: boolean;
  humanlike_jitter: boolean;
  hourly_request_warn: number;
  hourly_request_throttle: number;
  hourly_request_pause: number;
}

export function useStealthSettings(apiKey: string | null) {
  const [data, setData] = useState<StealthSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/stealth-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: StealthSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<StealthSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const resp = await fetch("/admin/stealth-settings", {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { success: boolean } & StealthSettingsData;
      const { success: _, ...settings } = result;
      setData(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  return { data, saving, saved, error, save, load };
}
