import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleCheck,
  CirclePlus,
  CircleX,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import type {
  ProviderModel,
  ProviderProfile,
  ProviderProfileInput,
  WorkerStatus,
} from "../../shared/contracts";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const emptyProfile: ProviderProfileInput = {
  name: "OpenAI 兼容服务",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  protocol: "auto",
  apiKey: "",
};

interface ModelTestState {
  status: "testing" | "success" | "failure";
  detail?: string;
}

export function SettingsDialog({
  open,
  onClose,
  onChanged,
}: SettingsDialogProps): React.JSX.Element | null {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [form, setForm] = useState<ProviderProfileInput>(emptyProfile);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string }>();
  const [worker, setWorker] = useState<WorkerStatus>();
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>(
    {},
  );

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId),
    [profiles, selectedId],
  );

  const load = async (): Promise<void> => {
    const [nextProfiles, workerStatus] = await Promise.all([
      window.paperxcel.providers.list(),
      window.paperxcel.worker.status(),
    ]);
    setProfiles(nextProfiles);
    setWorker(workerStatus);
    const target =
      nextProfiles.find((profile) => profile.id === selectedId) ??
      nextProfiles.find((profile) => profile.isActive) ??
      nextProfiles[0];
    if (target) selectProfile(target);
  };

  useEffect(() => {
    if (open) void load();
    // Load only when the dialog opens; later state updates must not refetch profiles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const clearModelDiscovery = (): void => {
    setModels([]);
    setModelTests({});
  };

  const selectProfile = (profile: ProviderProfile): void => {
    setSelectedId(profile.id);
    setForm({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      protocol: "auto",
      apiKey: "",
    });
    setResult(undefined);
    clearModelDiscovery();
  };

  const save = async (): Promise<void> => {
    if (!form.model.trim()) {
      setResult({ ok: false, detail: "请先获取并选择一个模型。" });
      return;
    }
    setSaving(true);
    setResult(undefined);
    try {
      const saved = await window.paperxcel.providers.save(form);
      if (selected?.isActive || profiles.length === 0) {
        await window.paperxcel.providers.setActive(saved.id);
      }
      await load();
      await onChanged();
      setResult({ ok: true, detail: "配置已保存。" });
    } catch (error) {
      setResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const fetchModels = async (): Promise<void> => {
    setLoadingModels(true);
    setResult(undefined);
    setModelTests({});
    try {
      const nextModels = await window.paperxcel.providers.models(form);
      setModels(nextModels);
      if (!form.model.trim() && nextModels[0]) {
        setForm((current) => ({ ...current, model: nextModels[0].id }));
      }
      setResult({
        ok: nextModels.length > 0,
        detail: nextModels.length
          ? `已获取 ${nextModels.length} 个模型。`
          : "服务未返回可用模型。",
      });
    } catch (error) {
      setModels([]);
      setResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingModels(false);
    }
  };

  const testModel = async (model: ProviderModel): Promise<void> => {
    setModelTests((current) => ({
      ...current,
      [model.id]: { status: "testing" },
    }));
    try {
      const nextResult = await window.paperxcel.providers.test({
        ...form,
        model: model.id,
      });
      setModelTests((current) => ({
        ...current,
        [model.id]: {
          status: nextResult.ok ? "success" : "failure",
          detail: nextResult.detail,
        },
      }));
    } catch (error) {
      setModelTests((current) => ({
        ...current,
        [model.id]: {
          status: "failure",
          detail: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const setActive = async (): Promise<void> => {
    if (!selectedId) return;
    await window.paperxcel.providers.setActive(selectedId);
    await load();
    await onChanged();
  };

  const remove = async (): Promise<void> => {
    if (!selectedId) return;
    await window.paperxcel.providers.remove(selectedId);
    setSelectedId(undefined);
    await load();
    await onChanged();
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">本地安全设置</span>
            <h2>模型供应商</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            title="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="settings-body">
          <aside className="provider-list">
            {profiles.map((profile) => (
              <button
                className={`provider-row ${profile.id === selectedId ? "selected" : ""}`}
                type="button"
                key={profile.id}
                onClick={() => selectProfile(profile)}
              >
                <span className="provider-icon">
                  <Server size={17} />
                </span>
                <span>
                  <strong>{profile.name}</strong>
                  <small>{profile.model}</small>
                </span>
                {profile.isActive && (
                  <Check className="active-check" size={16} />
                )}
              </button>
            ))}
            <button
              className="add-provider"
              type="button"
              onClick={() => {
                setSelectedId(undefined);
                setForm(emptyProfile);
                setResult(undefined);
                clearModelDiscovery();
              }}
            >
              <CirclePlus size={17} />
              新建供应商
            </button>
            <div className="worker-health">
              <span
                className={`health-dot ${worker?.available ? "good" : "bad"}`}
              />
              <div>
                <strong>文档引擎</strong>
                <small>{worker?.available ? "模糊全文检索" : "未连接"}</small>
              </div>
            </div>
          </aside>
          <div className="settings-form">
            <label>
              <span>名称</span>
              <input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                spellCheck={false}
                value={form.baseUrl}
                onChange={(event) => {
                  setForm((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }));
                  clearModelDiscovery();
                }}
              />
            </label>
            <label>
              <span>API Key</span>
              <div className="secret-input">
                <KeyRound size={16} />
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    selected?.hasApiKey
                      ? "已安全保存；留空则不修改"
                      : "输入 API Key"
                  }
                  value={form.apiKey}
                  onChange={(event) => {
                    setForm((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }));
                    clearModelDiscovery();
                  }}
                />
              </div>
            </label>
            <section className="provider-models-panel" aria-label="供应商模型">
              <header className="provider-models-header">
                <div>
                  <strong>模型列表</strong>
                  <small>
                    {models.length ? `${models.length} 个` : "尚未获取"}
                  </small>
                </div>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={loadingModels}
                  onClick={() => void fetchModels()}
                >
                  {loadingModels ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  获取模型列表
                </button>
              </header>
              {models.length ? (
                <div className="provider-model-list">
                  {models.map((model) => {
                    const testState = modelTests[model.id];
                    return (
                      <div
                        className={`provider-model-item ${
                          form.model === model.id ? "selected" : ""
                        }`}
                        key={model.id}
                      >
                        <button
                          className="provider-model-choice"
                          type="button"
                          aria-pressed={form.model === model.id}
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              model: model.id,
                            }))
                          }
                        >
                          <span>
                            <strong>{model.id}</strong>
                            {model.ownedBy && <small>{model.ownedBy}</small>}
                          </span>
                          {form.model === model.id && <Check size={14} />}
                        </button>
                        <span
                          className={`model-test-state ${testState?.status ?? ""}`}
                          title={testState?.detail}
                        >
                          {testState?.status === "testing" && (
                            <LoaderCircle className="spin" size={14} />
                          )}
                          {testState?.status === "success" && (
                            <CircleCheck size={14} />
                          )}
                          {testState?.status === "failure" && (
                            <CircleX size={14} />
                          )}
                        </span>
                        <button
                          className="icon-button model-test-button"
                          type="button"
                          title={`测试模型 ${model.id}`}
                          aria-label={`测试模型 ${model.id}`}
                          disabled={testState?.status === "testing"}
                          onClick={() => void testModel(model)}
                        >
                          <FlaskConical size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="provider-model-empty">暂无模型列表</div>
              )}
            </section>
            {result && (
              <div
                className={`form-result ${result.ok ? "success" : "failure"}`}
              >
                {result.ok ? <Check size={16} /> : <X size={16} />}
                <span>{result.detail}</span>
              </div>
            )}
            <footer className="form-actions">
              {selected && (
                <>
                  <button
                    className="icon-button danger"
                    type="button"
                    title="删除"
                    onClick={remove}
                  >
                    <Trash2 size={17} />
                  </button>
                  {!selected.isActive && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={setActive}
                    >
                      设为当前
                    </button>
                  )}
                </>
              )}
              <span className="action-spacer" />
              <button
                className="primary-button"
                type="button"
                disabled={saving}
                onClick={save}
              >
                {saving && <LoaderCircle className="spin" size={15} />}
                保存
              </button>
            </footer>
          </div>
        </div>
      </section>
    </div>
  );
}
