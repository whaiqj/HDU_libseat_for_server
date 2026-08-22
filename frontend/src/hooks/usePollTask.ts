import { useEffect, useRef, useState } from "react";
import { getGrabTask, GrabTaskStatus } from "../api/grabTasks";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 10 * 60 * 1000; // 10 分钟后放弃自动轮询

export function usePollTask(taskId: string | null) {
  const [task, setTask] = useState<GrabTaskStatus | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    // taskId 被清空（如任务被终止）时重置状态，避免残留上一次的展示
    if (!taskId) {
      setTask(null);
      setTimedOut(false);
      return;
    }
    setTask(null);
    setTimedOut(false);
    startedAt.current = Date.now();

    const interval = setInterval(async () => {
      try {
        const result = await getGrabTask(taskId);
        setTask(result);
        if (
          result.status === "success" ||
          result.status === "failed" ||
          result.status === "cancelled"
        ) {
          clearInterval(interval);
        } else if (Date.now() - startedAt.current > MAX_POLL_MS) {
          setTimedOut(true);
          clearInterval(interval);
        }
      } catch (e) {
        console.error("轮询失败", e);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [taskId]);

  return { task, timedOut };
}
