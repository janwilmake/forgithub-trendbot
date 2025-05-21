import {
  Env,
  stripeBalanceMiddleware,
  createClient,
  type StripeUser,
} from "stripeflare";

import indexHTML from "./index.html";
import resultsHTML from "./results.html";
import { fetchPopularRepos, processUserPreferences } from "./utils";

export { DORM } from "stripeflare";

// Extended user type with preferences
interface TrendingBotUser extends StripeUser {
  preferences: string | null;
  last_run: number | null;
}

export const migrations = {
  1: [
    `CREATE TABLE users (
      access_token TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0,
      name TEXT,
      email TEXT,
      verified_email TEXT,
      verified_user_access_token TEXT,
      card_fingerprint TEXT,
      client_reference_id TEXT,
      preferences TEXT,
      last_run INTEGER
    )`,
    `CREATE INDEX idx_users_balance ON users(balance)`,
    `CREATE INDEX idx_users_email ON users(email)`,
    `CREATE INDEX idx_users_verified_email ON users(verified_email)`,
    `CREATE INDEX idx_users_card_fingerprint ON users(card_fingerprint)`,
    `CREATE INDEX idx_users_client_reference_id ON users(client_reference_id)`,

    // Results table to store processed data for each user
    `CREATE TABLE results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_token TEXT,
      run_date INTEGER,
      content TEXT,
      FOREIGN KEY(access_token) REFERENCES users(access_token)
    )`,
    `CREATE INDEX idx_results_access_token ON results(access_token)`,
    `CREATE INDEX idx_results_run_date ON results(run_date)`,
  ],
};

const VERSION = "1.0.0";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle Stripeflare middleware
    const result = await stripeBalanceMiddleware<TrendingBotUser>(
      request,
      env,
      ctx,
      migrations,
      VERSION,
    );

    // If middleware returned a response, return it directly
    if (result.response) {
      return result.response;
    }

    if (!result.session) {
      return new Response("Something went wrong", { status: 404 });
    }

    const { user, userClient, headers } = result.session;

    // Create headers for response
    const responseHeaders = new Headers(headers);
    responseHeaders.append("Content-Type", "text/html");

    // API endpoints
    if (path === "/api/update-preferences" && request.method === "POST") {
      try {
        const { preferences } = await request.json();

        if (!preferences || typeof preferences !== "string") {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid preferences" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (!userClient) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "User client not available",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        await userClient
          .exec(
            "UPDATE users SET preferences = ? WHERE access_token = ?",
            preferences,
            user.access_token,
          )
          .toArray();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Results page
    if (path === "/results") {
      // Get results for the user
      if (!userClient) {
        return new Response("User client not available", { status: 500 });
      }

      const results = await userClient
        .exec(
          "SELECT * FROM results WHERE access_token = ? ORDER BY run_date DESC LIMIT 10",
          user.access_token,
        )
        .toArray();

      // Prepare results page
      const modifiedHtml = resultsHTML.replace(
        "</head>",
        `<script>
          window.userData = ${JSON.stringify({
            ...user,
            results: results.map((r) => ({
              id: r.id,
              run_date: r.run_date,
              content: r.content,
            })),
          })};
        </script></head>`,
      );

      return new Response(modifiedHtml, { headers: responseHeaders });
    }

    // Main page
    const modifiedHtml = indexHTML.replace(
      "</head>",
      `<script>
        window.userData = ${JSON.stringify({
          client_reference_id: user.client_reference_id,
          balance: user.balance,
          email: user.email,
          name: user.name,
          preferences: user.preferences,
        })};
      </script></head>`,
    );

    return new Response(modifiedHtml, { headers: responseHeaders });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // For daily cron job
    if (event.cron === "0 0 * * *") {
      // Daily at midnight
      ctx.waitUntil(runDailyJob(env, ctx));
    }
  },
};

async function runDailyJob(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log("Starting daily job to process user preferences");

  // Create a client for the aggregate database
  const aggregateClient = createClient({
    doNamespace: env.DORM_NAMESPACE,
    version: VERSION,
    migrations,
    ctx,
    name: "aggregate",
  });

  // Get all users with balance > 0
  const users = await aggregateClient
    .exec<TrendingBotUser>("SELECT * FROM users WHERE balance > 0")
    .toArray();

  console.log(`Found ${users.length} users with positive balance`);

  // Fetch popular repositories data once
  const reposData = await fetchPopularRepos();

  if (!reposData) {
    console.error("Failed to fetch repository data");
    return;
  }

  // Process each user's preferences
  for (const user of users) {
    try {
      // Skip users without preferences
      if (!user.preferences) {
        console.log(
          `User ${user.access_token} has no preferences set, skipping`,
        );
        continue;
      }

      // Create a client for this specific user
      const userClient = createClient({
        doNamespace: env.DORM_NAMESPACE,
        version: VERSION,
        migrations,
        ctx,
        name: user.access_token,
        mirrorName: "aggregate",
      });

      // Charge the user for this run (1 cent)
      const update = userClient.exec(
        "UPDATE users SET balance = balance - 100, last_run = ? WHERE access_token = ? AND balance >= 100",
        Date.now(),
        user.access_token,
      );

      await update.toArray();
      const { rowsWritten } = update;

      // If user couldn't be charged, skip
      if (rowsWritten === 0) {
        console.log(`Failed to charge user ${user.access_token}, skipping`);
        continue;
      }

      console.log(`Processing preferences for user ${user.access_token}`);

      // Process the user's preferences against the repository data
      const result = await processUserPreferences(
        reposData,
        user.preferences,
        env.OPENAI_API_KEY,
      );

      if (result) {
        // Store the result in the database
        await userClient
          .exec(
            "INSERT INTO results (access_token, run_date, content) VALUES (?, ?, ?)",
            user.access_token,
            Date.now(),
            result,
          )
          .toArray();

        console.log(`Stored results for user ${user.access_token}`);
      } else {
        console.error(
          `Failed to process preferences for user ${user.access_token}`,
        );
      }
    } catch (error) {
      console.error(`Error processing user ${user.access_token}:`, error);
    }
  }

  console.log("Daily job completed");
}
