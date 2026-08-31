import { useState, useEffect, useCallback } from "react";
import { ROOMS } from "./config/rooms";
import { toBeijingTimestamp } from "./utils/time";
import { createGrabTask, cancelGrabTask, getGrabTask, listGrabTasks } from "./api/grabTasks";
import {
  listAccounts,
  addAccount,
  refreshAccount,
  removeAccount,
  Account,
} from "./api/accounts";

// 登录态失效判定阈值：LOGIN_FAILED 且 lastLoginAt 距今超过该时长，视为"心跳掉线"（登录已失效）；
// 否则（lastLoginAt 为 null 或刚失败）视为"密码未通过"（登录失败）。
// 心跳每 5 分钟一次，阈值取 1 小时，留足心跳救回余量。
const SESSION_STALE_THRESHOLD_MS = 60 * 60 * 1000;

const POLL_INTERVAL_MS = 2000;

/** 本地日期字符串 "YYYY-MM-DD"（用户处于东八区，本地即北京时间） */
function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 将 UTC+8 锚定的时间戳（秒）格式化为 "今天 20:00" / "明天 08:30" / "9月2日 20:00"
 * 供任务状态卡片展示触发时刻
 */
function formatTriggerLabel(triggerAt: number): string {
  // 时间戳由 toBeijingTimestamp（强制 UTC+8）生成，加 8h 后用 UTC 取值器读出北京时刻
  const beijing = new Date(triggerAt * 1000 + 8 * 3600 * 1000);
  const hh = String(beijing.getUTCHours()).padStart(2, "0");
  const mm = String(beijing.getUTCMinutes()).padStart(2, "0");
  const now = new Date();
  const todayMidnight = toBeijingTimestamp(
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    0,
    0,
  );
  const dayOffset = Math.floor((triggerAt - todayMidnight) / 86400);
  const time = `${hh}:${mm}`;
  if (dayOffset === 0) {
    return `今天 ${time}`;
  }
  if (dayOffset === 1) {
    return `明天 ${time}`;
  }
  return `${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${time}`;
}

function TaskStatusDisplay({ status }: { status: TaskStatus }) {
  const [task, setTask] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const result = await getGrabTask(status.taskId);
        if (mounted) {
          setTask(result);
        }
        if (
          result.status === "success" ||
          result.status === "failed" ||
          result.status === "cancelled"
        ) {
          return false; // 停止轮询
        }
        return true; // 继续轮询
      } catch (e: any) {
        if (mounted) {
          setError(e.message ?? "查询失败");
        }
        return false;
      }
    };

    poll();
    const interval = setInterval(async () => {
      const shouldContinue = await poll();
      if (!shouldContinue) {
        clearInterval(interval);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [status.taskId]);

  if (error) {
    return (
      <div className="status-card status-card-error">
        <strong>{status.username}:</strong> {error}
      </div>
    );
  }

  if (!task) {
    return (
      <div className="status-card status-card-idle">
        <strong>{status.username}:</strong> 加载中...
      </div>
    );
  }

  // 盲抢候选：严格模式 + 指定了座位偏好（是否真走盲抢还取决于预解析结果）
  const blindCandidate = Boolean(task.strictMode && (task.seatPreference ?? []).length);
  const preparse = task.result?.preparse;
  // 预解析已明确失败 -> 大概率回退普通模式准点开抢；未执行/成功 -> 晚五秒
  const blindMode = blindCandidate && preparse?.ok !== false;

  let cardClass = "status-card status-card-idle";
  if (task.status === "success") {
    cardClass = "status-card status-card-success";
  } else if (task.status === "failed") {
    cardClass = "status-card status-card-failed";
  } else if (task.status === "cancelled") {
    cardClass = "status-card status-card-cancelled";
  } else if (task.status === "running") {
    cardClass = "status-card status-card-running";
  }

  return (
    <div className={cardClass}>
      <div>
        <strong>{status.username}:</strong>{" "}
        {task.status === "pending" &&
          `在 ${formatTriggerLabel(task.triggerAt)} 时${
            blindMode ? "晚五秒" : ""
          }触发该抢座任务`}
        {task.status === "running" && `抢座中（已尝试 ${task.attempts} 次）`}
        {task.status === "success" && `✓ 预约成功！座位号：${task.result?.seatTitle}`}
        {task.status === "failed" && `✗ 预约失败：${task.result?.reason}`}
        {task.status === "cancelled" && "已取消"}
      </div>
      {task.status === "running" &&
        Array.isArray(task.result?.takenSeats) &&
        (task.result.takenSeats as string[]).length > 0 && (
          <div className="status-taken">
            已被占用：{(task.result.takenSeats as string[]).join("、")}
          </div>
        )}
      {task.status === "pending" && blindCandidate && (
        <div className="status-taken">
          {!preparse && "预解析将在触发前 5 分钟执行"}
          {preparse?.ok === true && (
            <>
              盲抢就绪：{preparse.roomName} · 座位 {preparse.seatTitles?.join("、")}
              {preparse.autoPickedRoom && "（多房间同名座位，已自动锁定该房间）"}
              {Array.isArray(preparse.unresolvedTitles) &&
                preparse.unresolvedTitles.length > 0 &&
                `（${preparse.unresolvedTitles.join("、")} 不存在，已忽略）`}
            </>
          )}
          {preparse?.ok === false && (
            <>
              预解析失败：{preparse.reason}。触发时将自动重试解析，仍失败则回退普通模式准点开抢
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface TaskStatus {
  accountId: string;
  taskId: string;
  username: string;
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [accountSeatPrefs, setAccountSeatPrefs] = useState<Map<string, string>>(new Map());
  const [roomName, setRoomName] = useState(ROOMS[0].name);
  const [date, setDate] = useState(""); // "2026-08-20"
  const [startHour, setStartHour] = useState(8);
  const [endHour, setEndHour] = useState(22);
  const [defaultSeatPrefText, setDefaultSeatPrefText] = useState(""); // 默认座位偏好
  const [triggerTime, setTriggerTime] = useState("20:00");
  const [strictMode, setStrictMode] = useState(true);

  // 账号管理区块
  const [showAccountPanel, setShowAccountPanel] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [accountActionBusy, setAccountActionBusy] = useState(false);
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  const [taskStatuses, setTaskStatuses] = useState<TaskStatus[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelledMsg, setCancelledMsg] = useState<string | null>(null);

  // 加载账号列表；页面可见时每 30s 轮询一次，刷新登录态徽标
  const loadAccounts = useCallback(async () => {
    try {
      const list = await listAccounts();
      setAccounts(list);
    } catch {
      // 加载失败不打断主流程，下次轮询重试
    }
  }, []);

  useEffect(() => {
    loadAccounts();
    const timer = setInterval(loadAccounts, 30_000);
    return () => clearInterval(timer);
  }, [loadAccounts]);

  // 页面加载时拉取所有账号的活跃任务（pending / running），
  // 让刷新或重新打开页面后仍能看到之前提交的抢座任务。
  // 依赖项用账号 id 拼接字符串，避免 accounts 引用变化（30s 轮询）导致重复拉取。
  const accountIdsKey = accounts.map((a) => a.id).join(",");
  useEffect(() => {
    if (accounts.length === 0) return;
    // 只在页面首次加载 / 账号集合真正变化时拉一次，
    // 已存在的任务状态由各自的 TaskStatusDisplay 内部轮询维护。
    let cancelled = false;

    (async () => {
      const results = await Promise.allSettled(
        accounts.map((a) => listGrabTasks(a.id))
      );
      if (cancelled) return;

      const activeTasks: TaskStatus[] = [];
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const account = accounts[index];
        result.value
          .filter(
            (t) => t.status === "pending" || t.status === "running"
          )
          .forEach((t) => {
            activeTasks.push({
              accountId: account.id,
              taskId: t.id,
              username: account.username,
            });
          });
      });

      if (activeTasks.length > 0) {
        setTaskStatuses(activeTasks);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIdsKey]);

  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(accountId)) {
        newSet.delete(accountId);
        // 移除该账号的座位偏好
        setAccountSeatPrefs((prefs) => {
          const newPrefs = new Map(prefs);
          newPrefs.delete(accountId);
          return newPrefs;
        });
      } else {
        newSet.add(accountId);
        // 如果有默认座位偏好，自动填充
        if (defaultSeatPrefText) {
          setAccountSeatPrefs((prefs) => new Map(prefs).set(accountId, defaultSeatPrefText));
        }
      }
      return newSet;
    });
  };

  const updateAccountSeatPref = (accountId: string, pref: string) => {
    setAccountSeatPrefs((prev) => new Map(prev).set(accountId, pref));
  };

  const applyDefaultToAll = () => {
    if (!defaultSeatPrefText) return;
    setAccountSeatPrefs((prev) => {
      const newPrefs = new Map(prev);
      selectedAccountIds.forEach((id) => {
        newPrefs.set(id, defaultSeatPrefText);
      });
      return newPrefs;
    });
  };

  const hasRunningTasks = taskStatuses.length > 0;

  // 预约日期可选范围：仅今天/明天/后天（每次渲染重算，页面跨天后自动刷新）
  const nowDate = new Date();
  const minDateStr = toLocalDateStr(nowDate);
  const maxDateStr = toLocalDateStr(
    new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 2),
  );

  // 触发时间输入的实时提醒：填写的时刻未过 -> 今天触发；已过 -> 提交时将顺延到明天
  // 随每次渲染重算（页面每 30s 轮询账号触发重渲染），时间流逝后提醒会自动翻转
  const triggerDayLabel = (() => {
    const m = /^(\d{2}):(\d{2})$/.exec(triggerTime);
    if (!m) {
      return null;
    }
    const ts = toBeijingTimestamp(
      nowDate.getFullYear(),
      nowDate.getMonth() + 1,
      nowDate.getDate(),
      Number(m[1]),
      Number(m[2]),
    );
    return ts > Math.floor(Date.now() / 1000) ? "今天触发" : "明天触发";
  })();

  const isFormInvalid = !date || selectedAccountIds.size === 0 ||
    Array.from(selectedAccountIds).some(id => {
      const pref = accountSeatPrefs.get(id) || "";
      return pref.split(",").map(s => s.trim()).filter(Boolean).length === 0;
    });

  const handleSubmit = async () => {
    if (isFormInvalid) return;
    setSubmitError(null);
    setCancelError(null);
    setCancelledMsg(null);
    setTaskStatuses([]);

    try {
      const room = ROOMS.find((r) => r.name === roomName)!;
      const [y, m, d] = date.split("-").map(Number);
      const beginTime = toBeijingTimestamp(y, m, d, startHour);
      const duration = (endHour - startHour) * 3600;

      const timeMatch = /^(\d{2}):(\d{2})$/.exec(triggerTime);
      if (!timeMatch) {
        setSubmitError("请设置抢座触发时间");
        return;
      }
      const th = Number(timeMatch[1]);
      const tmin = Number(timeMatch[2]);

      // 触发时刻已过则顺延到明天同一时刻
      const now = new Date();
      const nowTs = Math.floor(Date.now() / 1000);
      let triggerAt = toBeijingTimestamp(
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        th,
        tmin,
      );
      let triggerDate = now;
      let rolledToTomorrow = false;
      if (triggerAt <= nowTs) {
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        triggerAt = toBeijingTimestamp(
          tomorrow.getFullYear(),
          tomorrow.getMonth() + 1,
          tomorrow.getDate(),
          th,
          tmin,
        );
        triggerDate = tomorrow;
        rolledToTomorrow = true;
      }

      // 预约日期不能早于触发日期：触发顺延到明天后，
      // 今天及更早的预约时段在触发时已经开始/结束，任务必然失败
      if (date < toLocalDateStr(triggerDate)) {
        setSubmitError(
          `触发时间为${rolledToTomorrow ? "明天" : "今天"} ${triggerTime}，` +
            "预约日期不能早于触发日期，请调整预约日期或触发时间",
        );
        return;
      }

      // 为每个选中的账号创建任务
      const newTaskStatuses: TaskStatus[] = [];
      const errors: string[] = [];

      for (const accountId of Array.from(selectedAccountIds)) {
        try {
          const seatPrefText = accountSeatPrefs.get(accountId) || "";
          const seatPreference = seatPrefText.split(",").map(s => s.trim()).filter(Boolean);

          const res = await createGrabTask({
            accountId,
            roomId: room.roomId,
            roomName: room.name,
            beginTime,
            duration,
            seatPreference,
            strictMode,
            triggerAt,
          });

          const account = accounts.find(a => a.id === accountId);
          newTaskStatuses.push({
            accountId,
            taskId: res.id,
            username: account?.username || accountId,
          });
        } catch (e: any) {
          const account = accounts.find(a => a.id === accountId);
          errors.push(`${account?.username || accountId}: ${e.message ?? "创建失败"}`);
        }
      }

      setTaskStatuses(newTaskStatuses);

      if (errors.length > 0) {
        setSubmitError(`部分任务创建失败：\n${errors.join("\n")}`);
      }
    } catch (e: any) {
      setSubmitError(e.message ?? "提交失败");
    }
  };

  const handleCancelAll = async () => {
    if (taskStatuses.length === 0) return;
    setCancelError(null);
    setCancelledMsg(null);

    const errors: string[] = [];
    for (const status of taskStatuses) {
      try {
        await cancelGrabTask(status.taskId);
      } catch (e: any) {
        errors.push(`${status.username}: ${e.message ?? "终止失败"}`);
      }
    }

    setTaskStatuses([]);

    if (errors.length > 0) {
      setCancelError(`部分任务终止失败：\n${errors.join("\n")}`);
    } else {
      setCancelledMsg("所有任务已终止，可重新设置并提交新任务");
    }
  };

  const handleAddAccount = async () => {
    if (!newUsername || !newPassword) return;
    setAccountActionBusy(true);
    setAccountError(null);
    setAccountMsg(null);
    try {
      await addAccount(newUsername, newPassword);
      setNewUsername("");
      setNewPassword("");
      setAccountMsg("账号添加成功");
      await loadAccounts();
    } catch (e: any) {
      setAccountError(e.message ?? "添加失败");
    } finally {
      setAccountActionBusy(false);
    }
  };

  const handleRefreshAccount = async (id: string) => {
    setAccountActionBusy(true);
    setAccountError(null);
    setAccountMsg(null);
    try {
      await refreshAccount(id);
      setAccountMsg("刷新登录成功");
      await loadAccounts();
    } catch (e: any) {
      setAccountError(e.message ?? "刷新失败");
    } finally {
      setAccountActionBusy(false);
    }
  };

  const handleRemoveAccount = async (id: string) => {
    setAccountActionBusy(true);
    setAccountError(null);
    setAccountMsg(null);
    try {
      await removeAccount(id);
      setAccountMsg("账号已删除");
      // 从选中列表中移除
      setSelectedAccountIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
      setAccountSeatPrefs((prev) => {
        const newMap = new Map(prev);
        newMap.delete(id);
        return newMap;
      });
      await loadAccounts();
    } catch (e: any) {
      setAccountError(e.message ?? "删除失败");
    } finally {
      setAccountActionBusy(false);
    }
  };

  const statusBadge = (account: Account) => {
    if (account.status !== "login_failed") {
      return <span className="badge" style={{ color: "green" }}>正常</span>;
    }
    // LOGIN_FAILED 细分（不动数据结构，仅前端文案）：
    // - lastLoginAt 很久之前（心跳掉线，会话曾有效）→ "登录已失效"
    // - lastLoginAt 为 null 或刚发生（create/refresh 密码未通过）→ "登录失败"
    const lastLoginAt = account.lastLoginAt
      ? new Date(account.lastLoginAt).getTime()
      : null;
    const isStale =
      lastLoginAt != null &&
      Date.now() - lastLoginAt > SESSION_STALE_THRESHOLD_MS;
    return isStale ? (
      <span className="badge" style={{ color: "#b45309" }}>登录已失效</span>
    ) : (
      <span className="badge" style={{ color: "red" }}>登录失败</span>
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">图书馆抢座</h1>
        <p className="page-subtitle">批量预约 · 定时触发 · 自动抢座</p>
      </header>

      <section className="card">
        <h2 className="card-title">选择账号</h2>
        {accounts.length === 0 ? (
          <p className="hint">请先在下方添加账号</p>
        ) : (
          <div className="account-list">
            {accounts.map((a) => (
              <label
                key={a.id}
                className={
                  "account-row" +
                  (selectedAccountIds.has(a.id) ? " selected" : "")
                }
              >
                <input
                  type="checkbox"
                  checked={selectedAccountIds.has(a.id)}
                  onChange={() => toggleAccountSelection(a.id)}
                />
                <div className="account-row-body">
                  <div className="account-row-head">
                    <span className="account-name">{a.username}</span>
                    {statusBadge(a)}
                  </div>
                  {selectedAccountIds.has(a.id) && (
                    <input
                      type="text"
                      className="input seat-pref-input"
                      placeholder="座位偏好（逗号分隔）"
                      value={accountSeatPrefs.get(a.id) || ""}
                      onChange={(e) => updateAccountSeatPref(a.id, e.target.value)}
                    />
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="bulk-box">
        <label htmlFor="defaultSeatPrefText">默认座位偏好（批量应用）</label>
        <div className="bulk-box-row">
          <input
            id="defaultSeatPrefText"
            className="input"
            value={defaultSeatPrefText}
            onChange={(e) => setDefaultSeatPrefText(e.target.value)}
            placeholder="400, 401, 402"
          />
          <button
            className="btn btn-secondary"
            onClick={applyDefaultToAll}
            disabled={!defaultSeatPrefText || selectedAccountIds.size === 0}
          >
            应用到全部
          </button>
        </div>
      </div>

      <section className="card">
        <h2 className="card-title">预约设置</h2>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="roomName">自习室</label>
            <select
              id="roomName"
              className="input"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
            >
              {ROOMS.map((r) => (
                <option key={r.name} value={r.name}>{r.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="date">预约日期</label>
            <input
              id="date"
              className="input"
              type="date"
              min={minDateStr}
              max={maxDateStr}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="startHour">时间段（小时）</label>
            <div className="time-range">
              <input
                id="startHour"
                className="input"
                type="number"
                value={startHour}
                onChange={(e) => setStartHour(Number(e.target.value))}
              />
              <span className="time-range-sep">至</span>
              <input
                aria-label="结束小时"
                className="input"
                type="number"
                value={endHour}
                onChange={(e) => setEndHour(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="triggerTime">抢座触发时间</label>
            <input
              id="triggerTime"
              className="input"
              type="time"
              value={triggerTime}
              onChange={(e) => setTriggerTime(e.target.value)}
            />
            {triggerDayLabel && <span className="hint">{triggerDayLabel}</span>}
          </div>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={strictMode}
            onChange={(e) => setStrictMode(e.target.checked)}
          />
          严格模式（只抢指定座位，不降级）
        </label>
      </section>

      <div className="actions">
        <button
          className="btn btn-primary btn-block"
          onClick={handleSubmit}
          disabled={isFormInvalid || hasRunningTasks}
        >
          为所有选中账号创建抢座任务
        </button>

        {hasRunningTasks && (
          <button className="btn btn-danger btn-block" onClick={handleCancelAll}>
            终止所有任务
          </button>
        )}
      </div>

      {submitError && <p className="msg" style={{ color: "red", whiteSpace: "pre-wrap" }}>{submitError}</p>}
      {cancelError && <p className="msg" style={{ color: "red", whiteSpace: "pre-wrap" }}>{cancelError}</p>}
      {cancelledMsg && <p className="msg" style={{ color: "#0b7285" }}>{cancelledMsg}</p>}

      {taskStatuses.length > 0 && (
        <section className="card status-section">
          <h2 className="card-title">任务状态</h2>
          {taskStatuses.map((status) => (
            <TaskStatusDisplay key={status.taskId} status={status} />
          ))}
        </section>
      )}

      <hr className="divider" />

      <button
        className="btn btn-secondary"
        onClick={() => setShowAccountPanel((v) => !v)}
      >
        {showAccountPanel ? "收起账号管理" : "账号管理"}
      </button>

      {showAccountPanel && (
        <div className="manage-panel">
          {accounts.length === 0 ? (
            <p className="hint">暂无账号，请先添加</p>
          ) : (
            <ul className="account-manage-list">
              {accounts.map((a) => (
                <li key={a.id} className="account-manage-row">
                  <div className="account-manage-info">
                    <span className="account-name">{a.username}</span>
                    {statusBadge(a)}
                    {a.sessionMeta?.lastCheckAt && (
                      <span className="account-meta">
                        最近检查：{new Date(a.sessionMeta.lastCheckAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="account-manage-actions">
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => handleRefreshAccount(a.id)}
                      disabled={accountActionBusy}
                    >
                      刷新登录
                    </button>
                    <button
                      className="btn btn-danger btn-small"
                      onClick={() => handleRemoveAccount(a.id)}
                      disabled={accountActionBusy}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="add-account-row">
            <input
              className="input"
              placeholder="学号"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
            <input
              className="input"
              placeholder="密码"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="btn btn-primary"
              onClick={handleAddAccount}
              disabled={accountActionBusy || !newUsername || !newPassword}
            >
              {accountActionBusy ? "验证中…" : "添加并验证"}
            </button>
          </div>

          {accountMsg && <p className="msg" style={{ color: "#0b7285" }}>{accountMsg}</p>}
          {accountError && <p className="msg" style={{ color: "red" }}>{accountError}</p>}
        </div>
      )}
    </div>
  );
}
