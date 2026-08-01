import { env } from "../config/env.js";

const MANDRILL_SEND_URL =
  "https://mandrillapp.com/api/1.0/messages/send.json";

type MandrillRecipient = {
  email: string;
  name?: string | null;
};

type SendTransactionalEmailInput = {
  to: MandrillRecipient;
  subject: string;
  html: string;
  text: string;
  tags?: string[];
  /*
   * Optional Mandrill metadata. Values must be plain strings.
   *
   * Never place message bodies, email addresses, names, tokens or
   * URL parameters here. Omitted entirely when not supplied, so
   * existing callers send exactly the payload they sent before.
   */
  metadata?: Record<string, string>;
};

type MandrillSendResult = {
  email?: string;
  status?: string;
  reject_reason?: string | null;
  _id?: string;
};

export type SendTransactionalEmailResult =
  | {
      ok: true;
      messageId: string | null;
      status: string;
    }
  | {
      ok: false;
      message: string;
    };

export const sendTransactionalEmail = async ({
  to,
  subject,
  html,
  text,
  tags = [],
  metadata,
}: SendTransactionalEmailInput): Promise<
  SendTransactionalEmailResult
> => {
  try {
    const response = await fetch(
      MANDRILL_SEND_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          key: env.MANDRILL_API_KEY,
          message: {
            from_email:
              env.MANDRILL_FROM_EMAIL,
            from_name:
              env.MANDRILL_FROM_NAME,
            subject,
            html,
            text,
            to: [
              {
                email: to.email,
                name:
                  to.name ?? undefined,
                type: "to",
              },
            ],
            auto_text: false,
            preserve_recipients: false,
            track_opens: true,
            track_clicks: true,
            tags,
            ...(metadata === undefined
              ? {}
              : { metadata }),
          },
          async: false,
        }),
      },
    );

    if (!response.ok) {
      console.error(
        "Mandrill request failed",
        {
          status: response.status,
          statusText:
            response.statusText,
        },
      );

      return {
        ok: false,
        message:
          "The email provider rejected the request.",
      };
    }

    const payload =
      (await response.json()) as
        | MandrillSendResult[]
        | {
            status?: string;
            name?: string;
            message?: string;
          };

    if (!Array.isArray(payload)) {
      console.error(
        "Mandrill returned an API error",
        {
          status: payload.status,
          name: payload.name,
          message: payload.message,
        },
      );

      return {
        ok: false,
        message:
          "The email provider returned an error.",
      };
    }

    const result = payload[0];

    if (
      !result ||
      result.status === "rejected" ||
      result.status === "invalid"
    ) {
      console.error(
        "Mandrill rejected recipient",
        {
          recipient:
            result?.email ?? to.email,
          status:
            result?.status ?? "unknown",
          rejectReason:
            result?.reject_reason ??
            null,
        },
      );

      return {
        ok: false,
        message:
          "The recommendation email could not be delivered.",
      };
    }

    return {
      ok: true,
      messageId:
        result._id ?? null,
      status:
        result.status ?? "sent",
    };
  } catch (error) {
    console.error(
      "Mandrill request threw an error",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown Mandrill error",
      },
    );

    return {
      ok: false,
      message:
        "The recommendation email could not be sent.",
    };
  }
};
