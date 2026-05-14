import type { FastifyInstance } from "fastify";

export function setupHealthMonitoring(app: FastifyInstance): void {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  // Track error rate
  let errorCount = 0;
  let requestCount = 0;
  let lastAlertAt = 0;

  // Reset counters every 60 seconds
  setInterval(() => {
    const errorRate = requestCount > 0 ? errorCount / requestCount : 0;
    // Alert if error rate > 1% and at least 10 requests
    if (errorRate > 0.01 && requestCount >= 10 && slackWebhookUrl) {
      const now = Date.now();
      // Throttle: max 1 alert per 5 minutes
      if (now - lastAlertAt > 5 * 60 * 1000) {
        sendSlackAlert(slackWebhookUrl, errorRate, errorCount, requestCount);
        lastAlertAt = now;
      }
    }
    errorCount = 0;
    requestCount = 0;
  }, 60_000);

  // Hook into Fastify to count requests and errors
  app.addHook("onResponse", (_request, reply, done) => {
    requestCount++;
    if (reply.statusCode >= 500) errorCount++;
    done();
  });
}

async function sendSlackAlert(
  webhookUrl: string,
  rate: number,
  errors: number,
  total: number,
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Warning: AI Survivor: ${(rate * 100).toFixed(1)}% error rate (${errors}/${total} requests in last 60s)`,
      }),
    });
  } catch {
    /* best-effort alerting */
  }
}
