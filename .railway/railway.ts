import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const database = volume("rewardhub-data", {
    region: "europe-west4-drams3a",
    sizeMB: 500,
  });

  const app = service("rewardhub-mvp", {
    build: "npm ci",
    start: "npm start",
    healthcheck: "/api/public/settings",
    replicas: { "europe-west4-drams3a": 1 },
    volumeMounts: {
      "/data": database,
    },
    env: {
      NODE_ENV: "production",
      DATABASE_PATH: "/data/rewardhub.db",
    },
  });

  return project("rewardhub", {
    resources: [app, database],
  });
});
