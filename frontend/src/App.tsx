import { useState, useEffect, useCallback } from "react";
import { ROOMS } from "./config/rooms";
import { toBeijingTimestamp } from "./utils/time";
import { createGrabTask, cancelGrabTask, getGrabTask } from "./api/grabTasks";
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
        {task.status === "pending" && "等待触发..."}
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
      const [th, tmin] = triggerTime.split(":").map(Number);

      const now = new Date();
      const ty = now.getFullYear();
      const tmo = now.getMonth() + 1;
      const td = now.getDate();
      const triggerAt = toBeijingTimestamp(ty, tmo, td, th, tmin);

      const nowTs = Math.floor(Date.now() / 1000);
      if (triggerAt <= nowTs) {
        setSubmitError(`触发时间 ${triggerTime} 已过，请重新设置`);
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
            categoryId: room.categoryId,
            contentId: room.contentId,
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
              value={triggerTime}
              onChange={(e) => setTriggerTime(e.target.value)}
              placeholder="20:00"
            />
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
