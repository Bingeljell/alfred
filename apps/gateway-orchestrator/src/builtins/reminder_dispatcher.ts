import { OutboundNotificationStore } from "../notification_store";
import { ReminderStore } from "./reminder_store";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ReminderDispatcherHandle = {
  stop: () => Promise<void>;
};

export function startReminderDispatcher(options: {
  reminderStore: ReminderStore;
  notificationStore: OutboundNotificationStore;
  pollIntervalMs?: number;
}): ReminderDispatcherHandle {
  const reminderStore = options.reminderStore;
  const notificationStore = options.notificationStore;
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  let active = true;

  const loop = async () => {
    while (active) {
      const due = await reminderStore.listDue(new Date());
      for (const reminder of due) {
        await notificationStore.enqueue({
          sessionId: reminder.sessionId,
          text: `Reminder: ${reminder.text}`,
          status: "reminder",
          jobId: reminder.id
        });
        await reminderStore.markTriggered(reminder.id);
      }

      await sleep(pollIntervalMs);
    }
  };

  void loop();

  return {
    stop: async () => {
      active = false;
      await sleep(pollIntervalMs + 10);
    }
  };
}
