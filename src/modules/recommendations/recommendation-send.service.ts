import { env } from "../../config/env.js";
import { sendTransactionalEmail } from "../../lib/mandrill.js";
import { supabaseAdmin } from "../../lib/supabase.js";

type RecommendationRow = {
  id: string;
  consultation_id: string;
  service_id: string;
  status: string;
  consultant_note: string | null;
};

type ConsultationRow = {
  id: string;
  client_profile_id: string;
  status: string;
};

type IntakeRow = {
  full_name: string;
  email: string;
};

type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  price_display: string | null;
};

export type SendRecommendationResult =
  | {
      ok: true;
      recommendationId: string;
      status: "sent";
      sentAt: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INVALID_TRANSITION"
        | "EMAIL_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const escapeHtml = (
  value: string,
): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const loadRecommendation = async (
  recommendationId: string,
): Promise<
  | {
      ok: true;
      recommendation: RecommendationRow;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("service_recommendations")
      .select(
        "id, consultation_id, service_id, status, consultant_note",
      )
      .eq("id", recommendationId)
      .maybeSingle();

  if (error) {
    console.error(
      "Recommendation lookup failed",
      {
        recommendationId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The recommendation could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The recommendation was not found.",
    };
  }

  return {
    ok: true,
    recommendation:
      data as unknown as RecommendationRow,
  };
};

const loadConsultation = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      consultation: ConsultationRow;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultations")
      .select(
        "id, client_profile_id, status",
      )
      .eq("id", consultationId)
      .maybeSingle();

  if (error) {
    console.error(
      "Recommendation consultation lookup failed",
      {
        consultationId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The consultation was not found.",
    };
  }

  return {
    ok: true,
    consultation:
      data as unknown as ConsultationRow,
  };
};

const loadClientIntake = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      intake: IntakeRow;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultation_intake")
      .select("full_name, email")
      .eq(
        "consultation_id",
        consultationId,
      )
      .maybeSingle();

  if (error) {
    console.error(
      "Recommendation intake lookup failed",
      {
        consultationId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The client contact information could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The client contact information was not found.",
    };
  }

  return {
    ok: true,
    intake:
      data as unknown as IntakeRow,
  };
};

const loadService = async (
  serviceId: string,
): Promise<
  | {
      ok: true;
      service: ServiceRow;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("services")
      .select(
        "id, name, description, price_display",
      )
      .eq("id", serviceId)
      .maybeSingle();

  if (error) {
    console.error(
      "Recommended service lookup failed",
      {
        serviceId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The recommended service could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The recommended service was not found.",
    };
  }

  return {
    ok: true,
    service:
      data as unknown as ServiceRow,
  };
};

const restoreProposedStatus = async ({
  recommendationId,
  adminProfileId,
  sentAt,
}: {
  recommendationId: string;
  adminProfileId: string;
  sentAt: string;
}): Promise<boolean> => {
  const { error } =
    await supabaseAdmin
      .from("service_recommendations")
      .update({
        status: "proposed",
        sent_at: null,
        sent_by_admin_id: null,
      })
      .eq("id", recommendationId)
      .eq("status", "sent")
      .eq(
        "sent_by_admin_id",
        adminProfileId,
      )
      .eq("sent_at", sentAt);

  if (error) {
    console.error(
      "Recommendation rollback failed",
      {
        recommendationId,
        adminProfileId,
        sentAt,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return false;
  }

  return true;
};

export const sendRecommendationToClient =
  async ({
    recommendationId,
    adminProfileId,
  }: {
    recommendationId: string;
    adminProfileId: string;
  }): Promise<SendRecommendationResult> => {
    const recommendationResult =
      await loadRecommendation(
        recommendationId,
      );

    if (!recommendationResult.ok) {
      return recommendationResult;
    }

    const { recommendation } =
      recommendationResult;

    if (
      recommendation.status !==
      "proposed"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "Only proposed recommendations can be sent.",
      };
    }

    const consultationResult =
      await loadConsultation(
        recommendation.consultation_id,
      );

    if (!consultationResult.ok) {
      return consultationResult;
    }

    if (
      consultationResult.consultation
        .status !== "completed"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "Recommendations can only be sent after the consultation is completed.",
      };
    }

    const [
      intakeResult,
      serviceResult,
    ] = await Promise.all([
      loadClientIntake(
        recommendation.consultation_id,
      ),
      loadService(
        recommendation.service_id,
      ),
    ]);

    if (!intakeResult.ok) {
      return intakeResult;
    }

    if (!serviceResult.ok) {
      return serviceResult;
    }

    const sentAt =
      new Date().toISOString();

    const {
      data: updatedRecommendation,
      error: updateError,
    } = await supabaseAdmin
      .from("service_recommendations")
      .update({
        status: "sent",
        sent_at: sentAt,
        sent_by_admin_id:
          adminProfileId,
      })
      .eq("id", recommendation.id)
      .eq("status", "proposed")
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error(
        "Recommendation send transition failed",
        {
          recommendationId:
            recommendation.id,
          adminProfileId,
          code: updateError.code,
          message:
            updateError.message,
          details:
            updateError.details,
          hint: updateError.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The recommendation could not be marked as sent.",
      };
    }

    if (!updatedRecommendation) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The recommendation status changed before it could be sent.",
      };
    }

    const clientName =
      intakeResult.intake.full_name.trim() ||
      "there";

    const serviceName =
      serviceResult.service.name.trim();

    const serviceDescription =
      serviceResult.service.description?.trim() ??
      "";

    const priceDisplay =
      serviceResult.service.price_display?.trim() ??
      "";

    const consultantNote =
      recommendation.consultant_note?.trim() ??
      "";

    const dashboardUrl =
      `${env.APP_URL}/dashboard/consultation/${recommendation.consultation_id}`;

    const emailResult =
      await sendTransactionalEmail({
        to: {
          email:
            intakeResult.intake.email,
          name: clientName,
        },
        subject:
          `A service has been recommended for you: ${serviceName}`,
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#364355;max-width:640px;margin:0 auto;">
            <h1 style="font-family:Georgia,serif;color:#364355;">Your recommended service</h1>
            <p>As-salāmu ʿalaykum ${escapeHtml(clientName)},</p>
            <p>Following your Make Hijrah consultation, a service has been recommended for you.</p>
            <div style="border:1px solid #d9e2de;padding:20px;margin:24px 0;">
              <h2 style="font-family:Georgia,serif;margin-top:0;color:#364355;">${escapeHtml(serviceName)}</h2>
              ${
                serviceDescription
                  ? `<p>${escapeHtml(serviceDescription)}</p>`
                  : ""
              }
              ${
                priceDisplay
                  ? `<p><strong>${escapeHtml(priceDisplay)}</strong></p>`
                  : ""
              }
              ${
                consultantNote
                  ? `<p><strong>Consultant note:</strong><br>${escapeHtml(consultantNote)}</p>`
                  : ""
              }
            </div>
            <p>
              <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#669282;color:#ffffff;text-decoration:none;padding:12px 18px;">
                View recommendation
              </a>
            </p>
            <p>Make Hijrah Consultations</p>
          </div>
        `,
        text: [
          `As-salāmu ʿalaykum ${clientName},`,
          "",
          "Following your Make Hijrah consultation, a service has been recommended for you.",
          "",
          serviceName,
          serviceDescription,
          priceDisplay,
          consultantNote
            ? `Consultant note: ${consultantNote}`
            : "",
          "",
          `View recommendation: ${dashboardUrl}`,
          "",
          "Make Hijrah Consultations",
        ]
          .filter(Boolean)
          .join("\n"),
        tags: [
          "recommendation-sent",
        ],
      });

    if (!emailResult.ok) {
      const rollbackSucceeded =
        await restoreProposedStatus({
          recommendationId:
            recommendation.id,
          adminProfileId,
          sentAt,
        });

      return {
        ok: false,
        code: rollbackSucceeded
          ? "EMAIL_ERROR"
          : "INTERNAL_ERROR",
        message: rollbackSucceeded
          ? "The recommendation email could not be sent."
          : "The email failed and the recommendation status could not be restored.",
      };
    }

    return {
      ok: true,
      recommendationId:
        recommendation.id,
      status: "sent",
      sentAt,
    };
  };
