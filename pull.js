// grinder_updater.js
// Handles `.pull grinder` from the Python bot: Python writes a request to Firebase
// (grinder_update/request), this module pulls from GitHub on THIS host, reports every step
// back (grinder_update/status) and restarts the engine. The supervisor in the main script
// re-forks the child when it exits with RESTART_EXIT_CODE, so the new code is loaded.

const { execFile } = require("child_process");
const path = require("path");

const RESTART_EXIT_CODE = 42;
const UPDATE_MAX_AGE_MS = 10 * 60 * 1000; // ignore requests older than this (engine was offline)
const REPO_DIR = process.env.GRINDER_REPO_DIR || __dirname;

// Never let credentials embedded in a remote URL reach Discord.
const sanitize = (s) => String(s || "").replace(/\/\/[^\/@\s]+@/g, "//***@").trim();

// 'https://github.com/Kurtis-Lam/my-discord-bot.git' + 'main' -> 'Kurtis-Lam/my-discord-bot/main'
function describeSource(remoteUrl, branch) {
  const m = String(remoteUrl || "").trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}/${branch}` : `origin/${branch}`;
}

function runCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: REPO_DIR, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({
          code,
          out: String(stdout || "").trim(),
          err: String(stderr || "").trim() || (error ? error.message : "")
        });
      }
    );
  });
}

function setupUpdater({ db, runningClients }) {
  const updateRef = db.ref("grinder_update");
  let busy = false;

  // Writes the whole status object each time; Python replays `events` it hasn't shown yet.
  function createReporter(reqId) {
    const events = [];
    let state = "running";
    let extra = {};
    const flush = () =>
      updateRef
        .child("status")
        .set({ id: reqId, state, ack: true, events, updatedAt: Date.now(), ...extra })
        .catch((e) => console.error("[updater] status write failed:", e.message));
    const push = (kind, text, detail) => {
      const ev = { kind, text: String(text) };
      if (detail) ev.detail = sanitize(detail).slice(0, 900);
      events.push(ev);
      return flush();
    };
    return {
      init: () => flush(),
      start: (t) => push("start", t),
      ok: (t) => push("ok", t),
      warn: (t) => push("warn", t),
      fail: async (t, d) => { state = "failed"; await push("fail", t, d); },
      done: async () => { state = "done"; await flush(); },
      restarting: async (more) => { state = "restarting"; extra = more; await flush(); }
    };
  }

  async function handleUpdateRequest(req) {
    const rep = createReporter(req.id);
    const force = !!req.force;
    const hard = !!req.hard;

    try {
      await rep.init(); // this is the "picked up" acknowledgement Python is waiting for

      // 1. repo + branch
      await rep.start("Checking git repository...");
      let r = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], 30000);
      if (r.code !== 0) return rep.fail("Not a git repository (or git missing)", r.err || r.out);
      const branch = r.out;
      if (branch === "HEAD") return rep.fail("Detached HEAD, can't pull. Check out a branch first.");
      await rep.ok(`Repository OK (branch \`${branch}\`)`);

      r = await runCmd("git", ["rev-parse", "--short", "HEAD"], 30000);
      const oldCommit = r.code === 0 ? r.out : "unknown";

      r = await runCmd("git", ["remote", "get-url", "origin"], 30000);
      const source = describeSource(r.code === 0 ? r.out : "", branch); // e.g. Kurtis-Lam/my-discord-bot/main

      // 2. fetch
      await rep.start(`Pulling from \`${source}\`...`);
      r = await runCmd("git", ["fetch", "origin"], 120000);
      if (r.code !== 0) return rep.fail(`Fetch from \`${source}\` failed`, r.err || r.out);
      await rep.ok(`Fetched from \`${source}\``);

      r = await runCmd("git", ["rev-list", "--count", `HEAD..origin/${branch}`], 30000);
      const behind = r.code === 0 && /^\d+$/.test(r.out) ? parseInt(r.out, 10) : 0;
      r = await runCmd("git", ["log", "-1", "--format=%s", `origin/${branch}`], 30000);
      const latestMsg = r.code === 0 ? r.out : "No commit message found";

      // 3. update the working tree
      if (hard) {
        await rep.start(`Resetting to \`${source}\` (${behind} commit(s) behind)...`);
        r = await runCmd("git", ["reset", "--hard", `origin/${branch}`], 60000);
        if (r.code !== 0) return rep.fail("Hard reset failed", r.err || r.out);
        await rep.ok(`Reset to \`${source}\``);
      } else {
        r = await runCmd("git", ["status", "--porcelain", "--untracked-files=no"], 30000);
        if (r.code === 0 && r.out) {
          await rep.start("Stashing local changes...");
          r = await runCmd(
            "git",
            ["-c", "user.name=grinder-updater", "-c", "user.email=grinder@localhost",
             "stash", "push", "-m", `auto-stash before grinder update ${Math.floor(Date.now() / 1000)}`],
            60000
          );
          if (r.code !== 0) return rep.fail("Couldn't stash local changes", r.err || r.out);
          await rep.ok("Stashed local changes (recover with `git stash pop`)");
        }
        await rep.start(`Pulling ${behind} commit(s) from \`${source}\`...`);
        r = await runCmd("git", ["pull", "--ff-only", "origin", branch], 180000);
        if (r.code !== 0) {
          return rep.fail("Git pull failed (if branches diverged, try `.pull g hard`)", r.err || r.out);
        }
      }

      r = await runCmd("git", ["rev-parse", "--short", "HEAD"], 30000);
      const newCommit = r.code === 0 ? r.out : "unknown";

      if (oldCommit === newCommit && !force) {
        await rep.ok(`Already up to date with \`${source}\`, no restart needed`);
        return rep.done();
      }
      await rep.ok(
        `Pulled \`${oldCommit}\` → \`${newCommit}\` from \`${source}\` (${behind} commit(s) behind)\n📝 Latest commit: *${latestMsg}*`
      );

      // 4. reinstall dependencies only when package files changed
      if (oldCommit !== "unknown" && newCommit !== "unknown" && oldCommit !== newCommit) {
        r = await runCmd("git", ["diff", "--name-only", oldCommit, newCommit], 30000);
        const depsChanged =
          r.code === 0 && r.out.split("\n").some((f) => /(^|\/)package(-lock)?\.json$/.test(f.trim()));
        if (depsChanged) {
          await rep.start("package.json changed, installing dependencies...");
          const npm = process.platform === "win32" ? "npm.cmd" : "npm";
          r = await runCmd(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], 300000);
          if (r.code !== 0) await rep.warn("npm install failed, restarting anyway (check the console)");
          else await rep.ok("Dependencies installed");
        }
      }

      // 5. restart: exit with the special code, the supervisor re-forks the freshly pulled script
      await rep.start("Restarting grinder engine...");
      await rep.restarting({ newCommit, restartAt: Date.now() });
      console.log(`[updater] Restarting on ${newCommit} (requested by ${req.requestedBy || "unknown"})`);

      for (const client of runningClients.values()) {
        try { client.destroy(); } catch (_) {}
      }
      setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
    } catch (e) {
      console.error("[updater] Unexpected error:", e);
      await rep.fail("Unexpected error during the grinder update", e && e.message);
    }
  }

  // Runs on every boot: if the previous process left state "restarting", we are the restarted one.
  async function finishPendingRestart() {
    try {
      const st = (await updateRef.child("status").once("value")).val();
      if (!st || st.state !== "restarting") return;
      const events = Array.isArray(st.events) ? st.events : Object.values(st.events || {});
      const took = st.restartAt ? Math.round((Date.now() - st.restartAt) / 1000) : null;
      events.push({
        kind: "ok",
        text: `Grinder restarted, now running \`${st.newCommit || "latest"}\`${took !== null ? ` (took ${took}s)` : ""}`
      });
      await updateRef.child("status").set({ id: st.id, state: "done", ack: true, events, updatedAt: Date.now() });
    } catch (e) {
      console.error("[updater] finishPendingRestart failed:", e.message);
    }
  }

  updateRef.child("request").on("value", async (snap) => {
    const req = snap.val();
    if (!req || !req.id || busy) return;
    busy = true;
    try {
      // Consume the request first, otherwise it would fire again after the restart.
      await updateRef.child("request").remove().catch(() => {});
      if (req.requestedAt && Date.now() - req.requestedAt > UPDATE_MAX_AGE_MS) {
        console.log(`[updater] Ignoring stale update request ${req.id}`);
        return;
      }
      console.log(`[updater] Update request ${req.id} from ${req.requestedBy || "unknown"}`);
      await handleUpdateRequest(req);
    } finally {
      busy = false;
    }
  });

  finishPendingRestart();
  console.log(`[updater] Listening for .pull grinder signals (repo dir: ${path.resolve(REPO_DIR)})`);
}

module.exports = { setupUpdater, describeSource, RESTART_EXIT_CODE };