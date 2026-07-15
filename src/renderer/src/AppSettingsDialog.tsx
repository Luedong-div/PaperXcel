import { useEffect, useState } from "react";
import {
  CircleAlert,
  FileText,
  FlaskConical,
  FolderOpen,
  KeyRound,
  Languages,
  Library,
  LoaderCircle,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { normalizeZoteroUserLibraryId } from "../../shared/zotero";
import type {
  OpenAlexConfigInput,
  OpenAlexTestResult,
  Paper,
  TranslationConfigInput,
  TranslationTestResult,
  ZoteroConfigInput,
  ZoteroTestResult,
} from "../../shared/contracts";

interface AppSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: AppSettingsSection;
  onImported: (papers: Paper[], detail: string) => void;
}

type AppSettingsSection = "doi" | "zotero" | "openalex" | "translation";

const emptyZoteroConfig: ZoteroConfigInput = {
  mode: "local",
  libraryType: "user",
  libraryId: "",
  collection: "",
  dataDir: "",
  apiKey: "",
};

const openAccessSources = [
  "Crossref PDF links",
  "ChemRxiv",
  "Europe PMC",
  "Unpaywall",
  "OpenAlex",
  "Semantic Scholar",
  "arXiv",
  "CORE",
];

export function AppSettingsDialog({
  open,
  onClose,
  initialSection = "doi",
  onImported,
}: AppSettingsDialogProps): React.JSX.Element | null {
  const [section, setSection] = useState<AppSettingsSection>(initialSection);
  const [scihubEnabled, setScihubEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zotero, setZotero] = useState<ZoteroConfigInput>(emptyZoteroConfig);
  const [zoteroHasApiKey, setZoteroHasApiKey] = useState(false);
  const [zoteroBusy, setZoteroBusy] = useState<
    "save" | "test" | "pull" | undefined
  >();
  const [zoteroResult, setZoteroResult] = useState<ZoteroTestResult>();
  const [openAlex, setOpenAlex] = useState<OpenAlexConfigInput>({ apiKey: "" });
  const [openAlexHasApiKey, setOpenAlexHasApiKey] = useState(false);
  const [openAlexBusy, setOpenAlexBusy] = useState<
    "save" | "test" | "clear" | undefined
  >();
  const [openAlexResult, setOpenAlexResult] = useState<OpenAlexTestResult>();
  const [translation, setTranslation] = useState<TranslationConfigInput>({
    appId: "",
    secretKey: "",
  });
  const [translationHasAppId, setTranslationHasAppId] = useState(false);
  const [translationHasSecretKey, setTranslationHasSecretKey] = useState(false);
  const [translationBusy, setTranslationBusy] = useState<
    "save" | "test" | undefined
  >();
  const [translationResult, setTranslationResult] =
    useState<TranslationTestResult>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSection(initialSection);
    setLoading(true);
    Promise.all([
      window.paperxcel.settings.getScihubEnabled(),
      window.paperxcel.zotero.getConfig(),
      window.paperxcel.openAlex.getConfig(),
      window.paperxcel.translation.getConfig(),
    ])
      .then(([enabled, config, openAlexConfig, translationConfig]) => {
        if (cancelled) return;
        setScihubEnabled(enabled);
        setZotero({
          mode: config.mode,
          libraryType: config.libraryType,
          libraryId: config.libraryId,
          collection: config.collection,
          dataDir: config.dataDir,
          apiKey: "",
        });
        setZoteroHasApiKey(config.hasApiKey);
        setZoteroResult(undefined);
        setOpenAlex({ apiKey: "" });
        setOpenAlexHasApiKey(openAlexConfig.hasApiKey);
        setOpenAlexResult(undefined);
        setTranslation({ appId: "", secretKey: "" });
        setTranslationHasAppId(translationConfig.hasAppId);
        setTranslationHasSecretKey(translationConfig.hasSecretKey);
        setTranslationResult(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialSection, open]);

  if (!open) return null;

  const toggleScihub = async (next: boolean): Promise<void> => {
    setSaving(true);
    try {
      const saved = await window.paperxcel.settings.setScihubEnabled(next);
      setScihubEnabled(saved);
    } finally {
      setSaving(false);
    }
  };

  const saveZotero = async (): Promise<void> => {
    setZoteroBusy("save");
    setZoteroResult(undefined);
    try {
      const saved = await window.paperxcel.zotero.saveConfig(zotero);
      setZoteroHasApiKey(saved.hasApiKey);
      setZotero((current) => ({ ...current, apiKey: "" }));
      setZoteroResult({ ok: true, detail: "Zotero 配置已保存。" });
    } catch (error) {
      setZoteroResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setZoteroBusy(undefined);
    }
  };

  const testZotero = async (): Promise<void> => {
    setZoteroBusy("test");
    setZoteroResult(undefined);
    try {
      setZoteroResult(await window.paperxcel.zotero.test(zotero));
    } catch (error) {
      setZoteroResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setZoteroBusy(undefined);
    }
  };

  const pullZotero = async (): Promise<void> => {
    setZoteroBusy("pull");
    setZoteroResult(undefined);
    try {
      const saved = await window.paperxcel.zotero.saveConfig(zotero);
      setZoteroHasApiKey(saved.hasApiKey);
      const result = await window.paperxcel.zotero.pull({
        ...zotero,
        apiKey: zotero.apiKey,
      });
      setZotero((current) => ({ ...current, apiKey: "" }));
      setZoteroResult({ ok: result.failed === 0, detail: result.detail });
      onImported(result.imported, result.detail);
    } catch (error) {
      setZoteroResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setZoteroBusy(undefined);
    }
  };

  const saveOpenAlex = async (): Promise<void> => {
    setOpenAlexBusy("save");
    setOpenAlexResult(undefined);
    try {
      const saved = await window.paperxcel.openAlex.saveConfig(openAlex);
      setOpenAlexHasApiKey(saved.hasApiKey);
      setOpenAlex({ apiKey: "" });
      setOpenAlexResult({ ok: true, detail: "OpenAlex 配置已保存。" });
    } catch (error) {
      setOpenAlexResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpenAlexBusy(undefined);
    }
  };

  const testOpenAlex = async (): Promise<void> => {
    setOpenAlexBusy("test");
    setOpenAlexResult(undefined);
    try {
      setOpenAlexResult(await window.paperxcel.openAlex.test(openAlex));
    } catch (error) {
      setOpenAlexResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpenAlexBusy(undefined);
    }
  };

  const clearCitationGraphCache = async (): Promise<void> => {
    setOpenAlexBusy("clear");
    setOpenAlexResult(undefined);
    try {
      const result = await window.paperxcel.citationGraph.clear();
      window.dispatchEvent(new Event("paperxcel:citation-graph-cache-cleared"));
      setOpenAlexResult({
        ok: true,
        detail:
          result.clearedPapers > 0 || result.clearedWorks > 0
            ? `已清除 ${result.clearedPapers} 篇论文、${result.clearedWorks} 个图谱节点的缓存。`
            : "引文图谱缓存已经是空的。",
      });
    } catch (error) {
      setOpenAlexResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpenAlexBusy(undefined);
    }
  };

  const saveTranslation = async (): Promise<void> => {
    setTranslationBusy("save");
    setTranslationResult(undefined);
    try {
      const saved = await window.paperxcel.translation.saveConfig(translation);
      setTranslationHasAppId(saved.hasAppId);
      setTranslationHasSecretKey(saved.hasSecretKey);
      setTranslation({ appId: "", secretKey: "" });
      setTranslationResult({
        ok: true,
        detail: "百度翻译 API 配置已加密保存。",
      });
    } catch (error) {
      setTranslationResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTranslationBusy(undefined);
    }
  };

  const testTranslation = async (): Promise<void> => {
    setTranslationBusy("test");
    setTranslationResult(undefined);
    try {
      setTranslationResult(
        await window.paperxcel.translation.test(translation),
      );
    } catch (error) {
      setTranslationResult({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTranslationBusy(undefined);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog app-settings-dialog"
        role="dialog"
        aria-modal="true"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">PaperXcel 设置</span>
            <h2>应用设置</h2>
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
        <div className="app-settings-body">
          <aside className="app-settings-nav" aria-label="应用设置分类">
            <button
              className={section === "doi" ? "active" : ""}
              type="button"
              onClick={() => setSection("doi")}
            >
              <CircleAlert size={16} />
              论文文件下载
            </button>
            <button
              className={section === "zotero" ? "active" : ""}
              type="button"
              onClick={() => setSection("zotero")}
            >
              <Library size={16} />
              Zotero 拉取
            </button>
            <button
              className={section === "openalex" ? "active" : ""}
              type="button"
              onClick={() => setSection("openalex")}
            >
              <Server size={16} />
              OpenAlex 图谱
            </button>
            <button
              className={section === "translation" ? "active" : ""}
              type="button"
              onClick={() => setSection("translation")}
            >
              <Languages size={16} />
              划词翻译
            </button>
          </aside>
          <main className="app-settings-panel">
            {section === "doi" ? (
              <>
                <section className="settings-section">
                  <div className="settings-section-heading">
                    <CircleAlert size={18} />
                    <div>
                      <h3>论文文件下载：版权与最终责任声明</h3>
                    </div>
                  </div>
                  <div className="notice-box">
                    <strong>最终责任</strong>
                    <p>
                      本工具仅面向拥有合法访问权限的用户，所提供的文献检索与下载功能旨在优先从开放获取、出版方明确开放或机构订阅许可覆盖的来源获取内容，Sci-Hub
                      仅作为在所有合法开放来源均无结果时的最后兜底选项；PaperXcel
                      不存储、不分发任何受版权保护的文件，亦不鼓励任何侵犯版权或违反当地法律的行为，你须自行确认对所下载内容拥有访问权限，并对通过本机网络、环境变量、自行修改代码或借助第三方服务所产生的一切下载行为承担全部责任，
                      因使用本工具而引发的任何版权纠纷、法律责任或损失均由使用者自行承担，与作者无关。{" "}
                    </p>
                    <label className="disclaimer-check">
                      <input
                        type="checkbox"
                        checked={scihubEnabled}
                        disabled={loading || saving}
                        onChange={(event) =>
                          void toggleScihub(event.target.checked)
                        }
                      />
                      <span>
                        我已阅读并同意免责声明，启用 Sci-Hub
                        兜底下载（遇到人机验证时由我手动完成）
                      </span>
                      {loading || saving}
                    </label>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-section-heading">
                    <FileText size={18} />
                    <div>
                      <h3>数据来源</h3>
                    </div>
                  </div>
                  <div className="source-grid">
                    {openAccessSources.map((source) => (
                      <span key={source}>{source}</span>
                    ))}
                    {scihubEnabled && (
                      <span className="source-scihub">Sci-Hub（兜底）</span>
                    )}
                  </div>
                </section>
              </>
            ) : section === "zotero" ? (
              <section className="settings-section zotero-settings-section">
                <div className="settings-section-heading">
                  <Library size={18} />
                  <div>
                    <h3>Zotero 文献库</h3>
                    <p>
                      同步论文元数据与 PDF，重复条目按 Zotero key 和 DOI 跳过。
                    </p>
                  </div>
                </div>

                <div className="zotero-form">
                  <label>
                    <span>连接方式</span>
                    <span className="segmented-control">
                      <button
                        className={zotero.mode === "local" ? "active" : ""}
                        type="button"
                        onClick={() =>
                          setZotero((current) => ({
                            ...current,
                            mode: "local",
                          }))
                        }
                      >
                        本地 Zotero
                      </button>
                      <button
                        className={zotero.mode === "web" ? "active" : ""}
                        type="button"
                        onClick={() =>
                          setZotero((current) => ({ ...current, mode: "web" }))
                        }
                      >
                        Zotero Web API
                      </button>
                    </span>
                  </label>

                  {zotero.mode === "web" && (
                    <>
                      <label>
                        <span>文献库类型</span>
                        <span className="segmented-control">
                          <button
                            className={
                              zotero.libraryType === "user" ? "active" : ""
                            }
                            type="button"
                            onClick={() =>
                              setZotero((current) => ({
                                ...current,
                                libraryType: "user",
                              }))
                            }
                          >
                            个人文献库
                          </button>
                          <button
                            className={
                              zotero.libraryType === "group" ? "active" : ""
                            }
                            type="button"
                            onClick={() =>
                              setZotero((current) => ({
                                ...current,
                                libraryType: "group",
                              }))
                            }
                          >
                            群组文献库
                          </button>
                        </span>
                      </label>
                      <label>
                        <span>
                          {zotero.libraryType === "group"
                            ? "群组 ID"
                            : "用户 ID"}
                        </span>
                        <input
                          spellCheck={false}
                          value={zotero.libraryId}
                          onChange={(event) =>
                            setZotero((current) => ({
                              ...current,
                              libraryId: event.target.value,
                            }))
                          }
                          onBlur={(event) =>
                            setZotero((current) =>
                              current.libraryType === "user"
                                ? {
                                    ...current,
                                    libraryId: normalizeZoteroUserLibraryId(
                                      event.target.value,
                                    ),
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>API Key</span>
                        <span className="secret-input">
                          <KeyRound size={16} />
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder={
                              zoteroHasApiKey
                                ? "已安全保存；留空则不修改"
                                : "输入 Zotero API Key"
                            }
                            value={zotero.apiKey}
                            onChange={(event) =>
                              setZotero((current) => ({
                                ...current,
                                apiKey: event.target.value,
                              }))
                            }
                          />
                        </span>
                      </label>
                    </>
                  )}

                  <label>
                    <span>集合名称</span>
                    <input
                      placeholder="留空则拉取整个文献库"
                      value={zotero.collection}
                      onChange={(event) =>
                        setZotero((current) => ({
                          ...current,
                          collection: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>本机 Zotero 数据目录</span>
                    <span className="path-input">
                      <input
                        spellCheck={false}
                        placeholder="留空使用 ~/Zotero"
                        value={zotero.dataDir}
                        onChange={(event) =>
                          setZotero((current) => ({
                            ...current,
                            dataDir: event.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        title="选择 Zotero 数据目录"
                        onClick={() =>
                          void window.paperxcel.zotero
                            .chooseDataDir()
                            .then((path) => {
                              if (path) {
                                setZotero((current) => ({
                                  ...current,
                                  dataDir: path,
                                }));
                              }
                            })
                        }
                      >
                        <FolderOpen size={15} />
                      </button>
                    </span>
                  </label>

                  {zoteroResult && (
                    <div
                      className={`form-result ${
                        zoteroResult.ok ? "success" : "failure"
                      }`}
                    >
                      <span>
                        {zoteroResult.detail}
                        {zoteroResult.itemCount !== undefined &&
                          ` · ${zoteroResult.itemCount} 条`}
                      </span>
                    </div>
                  )}

                  <footer className="zotero-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(zoteroBusy)}
                      onClick={() => void saveZotero()}
                    >
                      {zoteroBusy === "save" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Save size={14} />
                      )}
                      保存
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(zoteroBusy)}
                      onClick={() => void testZotero()}
                    >
                      {zoteroBusy === "test" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <FlaskConical size={14} />
                      )}
                      测试连接
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={Boolean(zoteroBusy)}
                      onClick={() => void pullZotero()}
                    >
                      {zoteroBusy === "pull" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      从 Zotero 拉取
                    </button>
                  </footer>
                </div>
              </section>
            ) : section === "openalex" ? (
              <section className="settings-section openalex-settings-section">
                <div className="settings-section-heading">
                  <Server size={18} />
                  <div>
                    <h3>OpenAlex 引文数据</h3>
                    <p>
                      API Key 可提高每日可用额度；留空时仍会尝试使用 OpenAlex
                      的低额度访问。
                    </p>
                  </div>
                </div>

                <div className="openalex-form">
                  <label>
                    <span>API Key</span>
                    <span className="secret-input">
                      <KeyRound size={16} />
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          openAlexHasApiKey
                            ? "已安全保存；留空则不修改"
                            : "输入 OpenAlex API Key（可选）"
                        }
                        value={openAlex.apiKey}
                        onChange={(event) =>
                          setOpenAlex({ apiKey: event.target.value })
                        }
                      />
                    </span>
                  </label>

                  <div className="notice-box openalex-cache-note">
                    <strong>本地缓存</strong>
                    <p>
                      图谱仅在你点击刷新时联网，成功结果缓存 7
                      天。部分请求失败时不会清空已有图谱。
                    </p>
                  </div>

                  {openAlexResult && (
                    <div
                      className={`form-result ${
                        openAlexResult.ok ? "success" : "failure"
                      }`}
                    >
                      <span>{openAlexResult.detail}</span>
                    </div>
                  )}

                  <footer className="zotero-actions">
                    <button
                      className="secondary-button citation-cache-clear"
                      type="button"
                      disabled={Boolean(openAlexBusy)}
                      onClick={() => void clearCitationGraphCache()}
                    >
                      {openAlexBusy === "clear" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      清除图谱缓存
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(openAlexBusy)}
                      onClick={() => void saveOpenAlex()}
                    >
                      {openAlexBusy === "save" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Save size={14} />
                      )}
                      保存
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={Boolean(openAlexBusy)}
                      onClick={() => void testOpenAlex()}
                    >
                      {openAlexBusy === "test" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <FlaskConical size={14} />
                      )}
                      测试连接
                    </button>
                  </footer>
                </div>
              </section>
            ) : (
              <section className="settings-section translation-settings-section">
                <div className="settings-section-heading">
                  <Languages size={18} />
                  <div>
                    <h3>划词翻译</h3>
                    <p>
                      目前仅支持使用百度翻译开放平台的通用文本翻译
                      API，当然你也可使用 AI 模型进行翻译。
                    </p>
                  </div>
                </div>

                <div className="translation-settings-form">
                  <label>
                    <span>APP ID</span>
                    <span className="secret-input">
                      <KeyRound size={14} />
                      <input
                        type="text"
                        autoComplete="off"
                        placeholder={
                          translationHasAppId
                            ? "已保存，留空表示保持不变"
                            : "输入百度翻译 APP ID"
                        }
                        value={translation.appId}
                        onChange={(event) =>
                          setTranslation((current) => ({
                            ...current,
                            appId: event.target.value,
                          }))
                        }
                      />
                    </span>
                  </label>
                  <label>
                    <span>密钥</span>
                    <span className="secret-input">
                      <KeyRound size={14} />
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder={
                          translationHasSecretKey
                            ? "已保存，留空表示保持不变"
                            : "输入百度翻译密钥"
                        }
                        value={translation.secretKey}
                        onChange={(event) =>
                          setTranslation((current) => ({
                            ...current,
                            secretKey: event.target.value,
                          }))
                        }
                      />
                    </span>
                  </label>

                  <div className="notice-box translation-credential-note">
                    <strong>如何获取凭据？</strong>
                    <p>请自行前往 https://api.fanyi.baidu.com/ 获取凭据。</p>
                    <strong>隐私说明</strong>
                    <p>
                      翻译时只向百度翻译 API 发送当前划线文字，PaperXcel
                      不会记录任何数据。
                    </p>
                  </div>

                  {translationResult && (
                    <div
                      className={`form-result ${
                        translationResult.ok ? "success" : "failure"
                      }`}
                    >
                      <span>{translationResult.detail}</span>
                    </div>
                  )}

                  <footer className="zotero-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(translationBusy)}
                      onClick={() => void saveTranslation()}
                    >
                      {translationBusy === "save" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Save size={14} />
                      )}
                      保存
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={Boolean(translationBusy)}
                      onClick={() => void testTranslation()}
                    >
                      {translationBusy === "test" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <FlaskConical size={14} />
                      )}
                      测试连接
                    </button>
                  </footer>
                </div>
              </section>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
