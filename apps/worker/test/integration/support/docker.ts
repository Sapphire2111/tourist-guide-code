import { getContainerRuntimeClient } from "testcontainers";

export type DockerStatus = { available: true } | { available: false; reason: string };

/** Есть ли контейнерный рантайм (Docker/Podman), доступный Testcontainers. */
export async function checkDocker(): Promise<DockerStatus> {
  try {
    await getContainerRuntimeClient();
    return { available: true };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}
