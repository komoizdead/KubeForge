export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

export function parseImageRef(image: string): ImageRef {
  let name = image.trim();
  let tag = "latest";

  const lastSlash = name.lastIndexOf("/");
  const lastColon = name.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = name.slice(lastColon + 1);
    name = name.slice(0, lastColon);
  }

  const segments = name.split("/");
  const first = segments[0] ?? "";
  const hasRegistry = segments.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");

  return {
    registry: hasRegistry ? first : "docker.io",
    repository: hasRegistry ? segments.slice(1).join("/") : name,
    tag,
  };
}

export type ContainerState = "created" | "running" | "paused" | "exited";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
}

export interface DockerClient {
  listContainers(): Promise<ContainerInfo[]>;
  getContainer(id: string): Promise<ContainerInfo | undefined>;
}

export function createInMemoryDockerClient(containers: ContainerInfo[] = []): DockerClient {
  return {
    async listContainers() {
      return containers;
    },
    async getContainer(id) {
      return containers.find((container) => container.id === id);
    },
  };
}
