import type { Finding, ResourceRef, Severity } from "@kubeforge/core";
import { parseImageRef } from "@kubeforge/docker";
import {
  podSpecOf,
  workloadRef,
  type ContainerSpec,
  type RbacBindingResource,
  type RbacPolicyRule,
  type RbacRoleResource,
  type RbacSubject,
  type SecretResource,
  type Workload,
} from "@kubeforge/kubernetes";

export interface SecurityRule {
  id: string;
  severity: Severity;
  title: string;
  remediation: string;
  violations(workload: Workload): string[];
}

function offendingContainers(
  workload: Workload,
  predicate: (container: ContainerSpec) => boolean,
): string[] {
  return (podSpecOf(workload)?.containers ?? [])
    .filter(predicate)
    .map((container) => container.name);
}

export const defaultRules: SecurityRule[] = [
  {
    id: "KF-SEC-001",
    severity: "critical",
    title: "Container runs in privileged mode",
    remediation: "Remove securityContext.privileged or replace it with the narrowest capabilities required.",
    violations: (workload) =>
      offendingContainers(workload, (container) => container.securityContext?.privileged === true),
  },
  {
    id: "KF-SEC-002",
    severity: "warning",
    title: "Container does not enforce a non-root user",
    remediation: "Set securityContext.runAsNonRoot: true on the container or pod.",
    violations: (workload) =>
      offendingContainers(workload, (container) => container.securityContext?.runAsNonRoot !== true),
  },
  {
    id: "KF-SEC-003",
    severity: "warning",
    title: "Container root filesystem is writable",
    remediation: "Set securityContext.readOnlyRootFilesystem: true and mount writable paths as volumes.",
    violations: (workload) =>
      offendingContainers(workload, (container) => container.securityContext?.readOnlyRootFilesystem !== true),
  },
  {
    id: "KF-SEC-004",
    severity: "error",
    title: "Container image uses a mutable tag",
    remediation: "Pin images to an immutable version tag or digest.",
    violations: (workload) =>
      offendingContainers(workload, (container) => parseImageRef(container.image).tag === "latest"),
  },
];

export function scanWorkloads(workloads: Workload[], rules: SecurityRule[] = defaultRules): Finding[] {
  return workloads.flatMap((workload) =>
    rules.flatMap((rule) => {
      const containers = rule.violations(workload);
      if (containers.length === 0) return [];

      return [
        {
          id: `${rule.id}:${workloadRef(workload)}`,
          severity: rule.severity,
          title: rule.title,
          detail: `Affected containers: ${containers.join(", ")}`,
          resource: {
            kind: workload.kind,
            name: workload.metadata.name,
            namespace: workload.metadata.namespace ?? "default",
          },
          remediation: rule.remediation,
        } satisfies Finding,
      ];
    }),
  );
}

function reference(resource: {
  kind: string;
  metadata: { name: string; namespace?: string };
}): ResourceRef {
  const namespaced =
    resource.kind === "Role" || resource.kind === "RoleBinding" || resource.kind === "Secret";
  return {
    kind: resource.kind,
    name: resource.metadata.name,
    ...(namespaced ? { namespace: resource.metadata.namespace ?? "default" } : {}),
  };
}

function referenceId(ref: ResourceRef): string {
  return ref.namespace ? `${ref.kind}/${ref.namespace}/${ref.name}` : `${ref.kind}/${ref.name}`;
}

function rbacFinding(
  ruleId: string,
  severity: Severity,
  title: string,
  detail: string,
  remediation: string,
  ref: ResourceRef,
): Finding {
  return {
    id: `${ruleId}:${referenceId(ref)}`,
    severity,
    title,
    detail,
    resource: ref,
    remediation,
  };
}

const READ_VERBS = ["get", "list", "watch"];

function hasResource(rule: RbacPolicyRule, resource: string): boolean {
  return (rule.resources ?? []).some((entry) => entry === "*" || entry === resource);
}

function hasAnyResource(rule: RbacPolicyRule, resources: string[]): boolean {
  return resources.some((resource) => hasResource(rule, resource));
}

function hasVerb(rule: RbacPolicyRule, verb: string): boolean {
  return (rule.verbs ?? []).some((entry) => entry === "*" || entry === verb);
}

function hasAnyVerb(rule: RbacPolicyRule, verbs: string[]): boolean {
  return verbs.some((verb) => hasVerb(rule, verb));
}

export interface RbacScanInput {
  roles?: RbacRoleResource[];
  clusterRoles?: RbacRoleResource[];
  roleBindings?: RbacBindingResource[];
  clusterRoleBindings?: RbacBindingResource[];
}

function scanRole(role: RbacRoleResource): Finding[] {
  const rules = role.rules ?? [];
  const ref = reference(role);
  const findings: Finding[] = [];

  const wildcard = rules.some(
    (rule) =>
      hasVerb(rule, "*") &&
      (hasResource(rule, "*") || (rule.nonResourceURLs ?? []).includes("*")),
  );
  if (wildcard) {
    findings.push(
      rbacFinding(
        "KF-RBAC-001",
        "critical",
        "Role grants wildcard permissions",
        "A rule grants every verb on every resource.",
        "Grant only the resources and verbs the workload actually needs.",
        ref,
      ),
    );
  }

  const readsSecrets = rules.some(
    (rule) => hasResource(rule, "secrets") && hasAnyVerb(rule, READ_VERBS),
  );
  if (readsSecrets) {
    findings.push(
      rbacFinding(
        "KF-RBAC-002",
        "error",
        "Role can read Secrets",
        "A rule grants get, list, or watch on secrets.",
        "Restrict Secret access to specific namespaces and use resourceNames where possible.",
        ref,
      ),
    );
  }

  const escalates = rules.some(
    (rule) =>
      (hasAnyResource(rule, ["roles", "clusterroles"]) &&
        hasAnyVerb(rule, ["escalate", "bind"])) ||
      (hasAnyResource(rule, ["users", "groups", "serviceaccounts"]) &&
        hasVerb(rule, "impersonate")),
  );
  if (escalates) {
    findings.push(
      rbacFinding(
        "KF-RBAC-003",
        "error",
        "Role can escalate privileges",
        "A rule grants escalate, bind, or impersonate.",
        "Remove escalation and impersonation verbs unless the role is a tightly controlled controller.",
        ref,
      ),
    );
  }

  const createsPods = rules.some(
    (rule) =>
      hasAnyResource(rule, ["pods", "pods/exec", "pods/attach", "pods/portforward"]) &&
      hasVerb(rule, "create"),
  );
  if (createsPods) {
    findings.push(
      rbacFinding(
        "KF-RBAC-004",
        "warning",
        "Role can create or exec into Pods",
        "A rule grants create on pods, pods/exec, pods/attach, or pods/portforward.",
        "Pod creation and exec allow access to mounted Secrets and service account tokens.",
        ref,
      ),
    );
  }

  return findings;
}

function subjectLabel(subject: RbacSubject): string {
  return subject.kind === "ServiceAccount"
    ? `ServiceAccount ${subject.namespace ?? "default"}/${subject.name}`
    : `${subject.kind} ${subject.name}`;
}

function scanBinding(binding: RbacBindingResource): Finding[] {
  const ref = reference(binding);
  const subjects = binding.subjects ?? [];
  const findings: Finding[] = [];

  if (binding.roleRef.kind === "ClusterRole" && binding.roleRef.name === "cluster-admin") {
    findings.push(
      rbacFinding(
        "KF-RBAC-005",
        "critical",
        "Binding grants cluster-admin",
        subjects.length > 0
          ? `Subjects: ${subjects.map(subjectLabel).join(", ")}.`
          : "The binding has no subjects.",
        "Bind a narrowly scoped ClusterRole instead of cluster-admin.",
        ref,
      ),
    );
  }

  const anonymous = subjects.filter(
    (subject) =>
      subject.name === "system:anonymous" ||
      (subject.kind === "Group" && subject.name === "system:unauthenticated"),
  );
  if (anonymous.length > 0) {
    findings.push(
      rbacFinding(
        "KF-RBAC-006",
        "critical",
        "Binding grants access to anonymous users",
        `Subjects: ${anonymous.map(subjectLabel).join(", ")}.`,
        "Remove system:anonymous and system:unauthenticated subjects from the binding.",
        ref,
      ),
    );
  }

  if (subjects.length === 0) {
    findings.push(
      rbacFinding(
        "KF-RBAC-007",
        "warning",
        "Binding has no subjects",
        "The binding does not grant access to any user, group, or service account.",
        "Delete unused bindings or add the intended subjects.",
        ref,
      ),
    );
  }

  return findings;
}

export function scanRBAC(input: RbacScanInput): Finding[] {
  const roles = [...(input.roles ?? []), ...(input.clusterRoles ?? [])];
  const bindings = [...(input.roleBindings ?? []), ...(input.clusterRoleBindings ?? [])];
  return [...roles.flatMap(scanRole), ...bindings.flatMap(scanBinding)];
}

const DEFAULT_WEAK_SECRET_VALUES = [
  "password",
  "changeme",
  "change-me",
  "secret",
  "admin",
  "test",
  "example",
  "letmein",
  "123456",
  "token",
  "root",
  "default",
];

const MINIMUM_SECRET_LENGTH = 8;

export interface SecretScanOptions {
  weakValues?: string[];
  minimumLength?: number;
}

function secretEntries(secret: SecretResource): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(secret.stringData ?? {})) {
    entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(secret.data ?? {})) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    entries.push([key, decoded]);
  }

  return entries;
}

export function scanSecrets(
  secrets: SecretResource[],
  options: SecretScanOptions = {},
): Finding[] {
  const weakValues = new Set(
    (options.weakValues ?? DEFAULT_WEAK_SECRET_VALUES).map((value) => value.toLowerCase()),
  );
  const minimumLength = options.minimumLength ?? MINIMUM_SECRET_LENGTH;

  return secrets.flatMap((secret) => {
    const ref = reference({ kind: secret.kind ?? "Secret", metadata: secret.metadata });
    const entries = secretEntries(secret);
    const findings: Finding[] = [];

    const weakKeys = entries
      .filter(([, value]) => value.length > 0 && weakValues.has(value.trim().toLowerCase()))
      .map(([key]) => key);
    if (weakKeys.length > 0) {
      findings.push({
        id: `KF-SECRET-001:${referenceId(ref)}`,
        severity: "critical",
        title: "Secret contains a default or weak value",
        detail: `Affected keys: ${weakKeys.join(", ")}`,
        resource: ref,
        remediation: "Rotate the value and load it from a secret manager instead of committing defaults.",
      });
    }

    const shortKeys = entries
      .filter(([, value]) => value.length < minimumLength)
      .map(([key]) => key);
    if (shortKeys.length > 0) {
      findings.push({
        id: `KF-SECRET-002:${referenceId(ref)}`,
        severity: "warning",
        title: "Secret value is empty or unusually short",
        detail: `Affected keys: ${shortKeys.join(", ")}`,
        resource: ref,
        remediation: `Use at least ${minimumLength} characters of high-entropy data for each secret value.`,
      });
    }

    const tlsKeys = entries
      .filter(([key]) => /(^|\.)(key|pem|crt)$/i.test(key))
      .map(([key]) => key);
    if (tlsKeys.length > 0 && secret.type !== "kubernetes.io/tls") {
      findings.push({
        id: `KF-SECRET-003:${referenceId(ref)}`,
        severity: "warning",
        title: "TLS material is stored in a non-TLS Secret",
        detail: `Affected keys: ${tlsKeys.join(", ")}`,
        resource: ref,
        remediation:
          "Use type kubernetes.io/tls for certificates and private keys so consumers validate the payload.",
      });
    }

    return findings;
  });
}

export interface WorkloadPolicy {
  id: string;
  severity: Severity;
  title: string;
  remediation: string;
  violations(workload: Workload): string[];
}

const DANGEROUS_CAPABILITIES = new Set([
  "ALL",
  "SYS_ADMIN",
  "NET_ADMIN",
  "NET_RAW",
  "SYS_PTRACE",
  "SYS_MODULE",
  "DAC_READ_SEARCH",
]);

export const defaultPolicies: WorkloadPolicy[] = [
  {
    id: "KF-POLICY-001",
    severity: "error",
    title: "Pod shares host namespaces",
    remediation:
      "Disable hostNetwork, hostPID, and hostIPC unless the workload is a node-level agent.",
    violations: (workload) => {
      const flags: string[] = [];
      if (workload.spec.hostNetwork === true) flags.push("hostNetwork");
      if (workload.spec.hostPID === true) flags.push("hostPID");
      if (workload.spec.hostIPC === true) flags.push("hostIPC");
      return flags;
    },
  },
  {
    id: "KF-POLICY-002",
    severity: "error",
    title: "Pod mounts a hostPath volume",
    remediation: "Use a PersistentVolumeClaim or a projected volume instead of hostPath.",
    violations: (workload) =>
      (workload.spec.volumes ?? [])
        .filter((volume) => volume.hostPath !== undefined)
        .map((volume) => volume.name ?? volume.hostPath?.path ?? "hostPath"),
  },
  {
    id: "KF-POLICY-003",
    severity: "critical",
    title: "Container adds dangerous Linux capabilities",
    remediation: "Drop all capabilities and add back only the specific capabilities required.",
    violations: (workload) =>
      (podSpecOf(workload)?.containers ?? []).flatMap((container) => {
        const added = (container.securityContext?.capabilities?.add ?? []).filter((capability) =>
          DANGEROUS_CAPABILITIES.has(capability.toUpperCase()),
        );
        return added.length > 0 ? [`${container.name} (${added.join(", ")})`] : [];
      }),
  },
  {
    id: "KF-POLICY-004",
    severity: "warning",
    title: "Container has no resource limits",
    remediation: "Set resources.limits.cpu and resources.limits.memory for every container.",
    violations: (workload) =>
      (podSpecOf(workload)?.containers ?? [])
        .filter(
          (container) =>
            container.resources?.limits?.cpu === undefined &&
            container.resources?.limits?.memory === undefined,
        )
        .map((container) => container.name),
  },
  {
    id: "KF-POLICY-005",
    severity: "warning",
    title: "Container permits privilege escalation",
    remediation: "Set securityContext.allowPrivilegeEscalation: false on every container.",
    violations: (workload) =>
      (podSpecOf(workload)?.containers ?? [])
        .filter((container) => container.securityContext?.allowPrivilegeEscalation !== false)
        .map((container) => container.name),
  },
];

export function scanPolicies(
  workloads: Workload[],
  policies: WorkloadPolicy[] = defaultPolicies,
): Finding[] {
  return workloads.flatMap((workload) =>
    policies.flatMap((policy) => {
      const violations = policy.violations(workload);
      if (violations.length === 0) return [];

      return [
        {
          id: `${policy.id}:${workloadRef(workload)}`,
          severity: policy.severity,
          title: policy.title,
          detail: violations.join(", "),
          resource: {
            kind: workload.kind,
            name: workload.metadata.name,
            namespace: workload.metadata.namespace ?? "default",
          },
          remediation: policy.remediation,
        } satisfies Finding,
      ];
    }),
  );
}
