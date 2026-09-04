import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Scheduled blog publishing. Migration 052 defines
 * publish_due_blog_posts() and migration 056 restricts it to the
 * service role; this is the thin wrapper the worker calls.
 *
 * Nothing here decides what is due. The predicate -- status =
 * 'scheduled' and scheduled_for <= now() -- lives in the RPC, and
 * so does the published_at rule (coalesce(published_at,
 * scheduled_for, now())). This layer forwards the call and reports
 * how many posts it released; it does not recompute or duplicate
 * either rule.
 */

export type PublishDueBlogPostsResult =
  | {
      ok: true;
      publishedCount: number;
    }
  | {
      ok: false;
      message: string;
    };

export const publishDueBlogPosts =
  async (): Promise<PublishDueBlogPostsResult> => {
    const { data, error } =
      await supabaseAdmin.rpc(
        "publish_due_blog_posts",
      );

    if (error) {
      console.error(
        "Blog scheduled-publishing RPC failed",
        {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
        message: error.message,
      };
    }

    return {
      ok: true,
      publishedCount:
        typeof data === "number" ? data : 0,
    };
  };
