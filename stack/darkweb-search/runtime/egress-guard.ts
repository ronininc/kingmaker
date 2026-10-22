// Ronin / Solomon — Egress Guard Runtime v1
// Network egress allowlist. Any connection attempt to a non-allowlisted host
// is blocked and logged. This is the exfiltration boundary.

export interface EgressRule {
  /** Host pattern: exact hostname or *.domain.com wildcard */
  hostPattern: string;
  /** Allowed ports. Empty = all ports. */
  ports: number[];
  /** Why this host is allowlisted */
  reasonPlain: string;
  /** Who authorized it */
  authorizedBy: string;
}

/** Default allowlist. Deliberately minimal. Expand only with founder tap. */
export const DEFAULT_EGRESS_ALLOWLIST: EgressRule[] = [
  {
    hostPattern: 'api.github.com',
    ports: [443],
    reasonPlain: 'GitHub API for repo operations',
    authorizedBy: 'FOUNDER',
  },
  {
    hostPattern: 'raw.githubusercontent.com',
    ports: [443],
    reasonPlain: 'GitHub raw file fetches',
    authorizedBy: 'FOUNDER',
  },
  {
    hostPattern: 'huggingface.co',
    ports: [443],
    reasonPlain: 'Official model weight downloads (provenance-verified only)',
    authorizedBy: 'FOUNDER',
  },
  {
    hostPattern: 'cdn-lfs.huggingface.co',
    ports: [443],
    reasonPlain: 'HuggingFace LFS for model weights',
    authorizedBy: 'FOUNDER',
  },
  {
    hostPattern: 'pypi.org',
    ports: [443],
    reasonPlain: 'Python package index (tool installs only)',
    authorizedBy: 'FOUNDER',
  },
  {
    hostPattern: 'files.pythonhosted.org',
    ports: [443],
    reasonPlain: 'PyPI file hosting',
    authorizedBy: 'FOUNDER',
  },
  {
    hostPattern: 'registry.npmjs.org',
    ports: [443],
    reasonPlain: 'npm registry (tool installs only)',
    authorizedBy: 'FOUNDER',
  },
];

function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h === p;
}

export interface EgressCheck {
  allowed: boolean;
  matchedRule?: EgressRule;
  reasonPlain: string;
}

/**
 * Check whether a network connection is allowed. Pure function — no side
 * effects. The caller is responsible for logging blocked attempts to the
 * audit chain as EGRESS_BLOCKED events.
 */
export function checkEgress(
  host: string,
  port: number,
  allowlist: EgressRule[] = DEFAULT_EGRESS_ALLOWLIST,
): EgressCheck {
  for (const rule of allowlist) {
    if (!hostMatchesPattern(host, rule.hostPattern)) continue;
    if (rule.ports.length > 0 && !rule.ports.includes(port)) {
      return {
        allowed: false,
        reasonPlain:
          `Host ${host} is allowlisted but port ${port} is not. ` +
          `Allowed ports: ${rule.ports.join(', ')}.`,
      };
    }
    return {
      allowed: true,
      matchedRule: rule,
      reasonPlain: `Allowed by rule: ${rule.reasonPlain}`,
    };
  }
  return {
    allowed: false,
    reasonPlain:
      `Host ${host} is not on the egress allowlist. Connection blocked. ` +
      `This attempt should be logged as EGRESS_BLOCKED.`,
  };
}

/**
 * Tor-only egress check for dark web operations. When torOnly is true,
 * ALL clearnet hosts are blocked regardless of the allowlist — only
 * .onion addresses are permitted.
 */
export function checkEgressTorOnly(
  host: string,
  port: number,
): EgressCheck {
  const h = host.toLowerCase();
  if (!h.endsWith('.onion')) {
    return {
      allowed: false,
      reasonPlain:
        `Tor-only mode: ${host} is not a .onion address. ` +
        `Clearnet connections are blocked during dark web sessions. ` +
        `Fail closed — no fallback.`,
    };
  }
  // .onion addresses always go through Tor on the standard ports
  if (port !== 80 && port !== 443 && port !== 9050 && port !== 9150) {
    return {
      allowed: false,
      reasonPlain: `Tor-only mode: port ${port} not permitted for .onion traffic.`,
    };
  }
  return {
    allowed: true,
    reasonPlain: `Tor-only: .onion address ${host} permitted via Tor circuit.`,
  };
}
