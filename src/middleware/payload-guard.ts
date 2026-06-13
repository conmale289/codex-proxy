import { bodyLimit } from "hono/body-limit";

// 25 MB payload limit (avoids OOM attacks and upstream WAF immediate-bans)
const MAX_PAYLOAD_SIZE = 25 * 1024 * 1024;

export const payloadGuard = bodyLimit({
  maxSize: MAX_PAYLOAD_SIZE,
  onError: (c) => {
    return c.json(
      {
        error: {
          message: `Payload too large. Maximum allowed size is ${MAX_PAYLOAD_SIZE / 1024 / 1024}MB. This limit is enforced to prevent Node.js OOM crashes and upstream unusual activity WAF bans.`,
          type: "payload_too_large",
          param: null,
          code: "payload_too_large",
        },
      },
      413
    );
  },
});
