/**
 * The shape every JSON route in this app has, and the three things that shape
 * exists to make impossible.
 *
 * 1. **An acting user that came from the request.** `route()` hands the handler
 *    a `user` it fetched from the session cookie. There is no parameter, no
 *    body field and no header a caller can set to change who they are. See
 *    docs/PLATFORM.md — the specification this replaces read `student_id` out
 *    of the request body, which is an impersonation hole with a friendly name.
 * 2. **An unvalidated body.** `body` is a validator, not a type. If you declare
 *    one you get a parsed value; if you do not, there is no `ctx.body` to read.
 * 3. **An error the client has to guess at.** Everything that goes wrong leaves
 *    through `ApiError` and arrives as the same JSON envelope with a stable
 *    machine-readable `code`.
 *
 * There is no validation library here on purpose. `zod` is not a dependency and
 * adding one to express "an object with a phone and a six-digit code" would be
 * 60 kB of runtime for eleven call sites. The combinators in `v` below cover
 * what the routes actually need and typecheck the same way.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import type { User, UserRole } from "@prisma/client";
import { requireUser, getSession } from "@/lib/session";
import type { Session } from "@/lib/session";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The error codes a client may branch on. Adding one is cheap; changing the
 * meaning of an existing one is not, because a phone in a village on 2G is
 * running last month's bundle and will branch on the old meaning.
 */
export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "NOT_AVAILABLE"
  | "INTERNAL";

const STATUS_FOR: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_AVAILABLE: 503,
  INTERNAL: 500,
};

export interface FieldIssue {
  /** Dotted path into the body: `pages.0.contentType`. */
  path: string;
  message: string;
}

/**
 * The only way to fail a request. Throw it from anywhere inside a handler —
 * including from deep inside a helper — and `route()` turns it into the
 * envelope below. Anything else that escapes becomes a 500 with no detail,
 * because an unexpected exception's message is as likely to be a connection
 * string as it is to be useful.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly issues?: FieldIssue[];

  constructor(code: ApiErrorCode, message: string, issues?: FieldIssue[]) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_FOR[code];
    this.issues = issues;
  }

  static validation(issues: FieldIssue[]): ApiError {
    return new ApiError(
      "VALIDATION_FAILED",
      issues.length === 1
        ? `${issues[0].path}: ${issues[0].message}`
        : `${issues.length} fields are invalid`,
      issues,
    );
  }

  static notFound(what: string): ApiError {
    return new ApiError("NOT_FOUND", `${what} not found`);
  }

  static forbidden(why = "Not permitted"): ApiError {
    return new ApiError("FORBIDDEN", why);
  }
}

/**
 * Every error response, without exception.
 *
 * `requestId` is echoed from the `x-request-id` header when the caller sent one
 * and generated when they did not, and is also set as a response header. It is
 * the only thing that makes a support message — "it said something went wrong"
 * — into something greppable.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    issues?: FieldIssue[];
    requestId: string;
  };
}

export function errorResponse(err: ApiError, requestId: string): NextResponse {
  const body: ApiErrorBody = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.issues ? { issues: err.issues } : {}),
      requestId,
    },
  };
  return NextResponse.json(body, {
    status: err.status,
    headers: { "x-request-id": requestId },
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A validator both narrows a type and collects every problem it found, rather
 * than throwing on the first. A student filling a form wants all four mistakes
 * at once, not one per round trip on a connection that takes two seconds to
 * complete one.
 */
export interface Validator<T> {
  /** Push onto `issues` and return anything on failure; the caller checks `issues`. */
  parse(value: unknown, path: string, issues: FieldIssue[]): T;
}

function fail<T>(issues: FieldIssue[], path: string, message: string): T {
  issues.push({ path, message });
  return undefined as T;
}

type Shape = Record<string, Validator<unknown>>;
type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Validator<infer T> ? T : never };

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Validator<string> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "string") return fail(issues, path, "must be a string");
        const s = opts.trim === false ? value : value.trim();
        if (opts.min !== undefined && s.length < opts.min)
          return fail(issues, path, `must be at least ${opts.min} characters`);
        if (opts.max !== undefined && s.length > opts.max)
          return fail(issues, path, `must be at most ${opts.max} characters`);
        if (opts.pattern && !opts.pattern.test(s))
          return fail(issues, path, "is not in the expected format");
        return s;
      },
    };
  },

  /**
   * E.164, normalised. Indian numbers arrive in five spellings — `9876543210`,
   * `09876543210`, `+91 98765 43210`, `91-9876543210`, `+919876543210` — and
   * every one of them is the same person. Normalising here rather than at each
   * call site is what makes `@@unique([scopeId, phone])` mean anything: the
   * database will not do it for you, as the schema comment says in as many words.
   */
  phone(): Validator<string> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "string") return fail(issues, path, "must be a string");
        const normalised = normalisePhone(value);
        if (!normalised) return fail(issues, path, "is not a valid phone number");
        return normalised;
      },
    };
  },

  int(opts: { min?: number; max?: number } = {}): Validator<number> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "number" || !Number.isInteger(value))
          return fail(issues, path, "must be an integer");
        if (opts.min !== undefined && value < opts.min)
          return fail(issues, path, `must be at least ${opts.min}`);
        if (opts.max !== undefined && value > opts.max)
          return fail(issues, path, `must be at most ${opts.max}`);
        return value;
      },
    };
  },

  number(opts: { min?: number; max?: number } = {}): Validator<number> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "number" || !Number.isFinite(value))
          return fail(issues, path, "must be a number");
        if (opts.min !== undefined && value < opts.min)
          return fail(issues, path, `must be at least ${opts.min}`);
        if (opts.max !== undefined && value > opts.max)
          return fail(issues, path, `must be at most ${opts.max}`);
        return value;
      },
    };
  },

  boolean(): Validator<boolean> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "boolean") return fail(issues, path, "must be true or false");
        return value;
      },
    };
  },

  /** An ISO-8601 instant, returned as a `Date`. */
  date(): Validator<Date> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "string") return fail(issues, path, "must be an ISO-8601 string");
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return fail(issues, path, "is not a valid date");
        return d;
      },
    };
  },

  uuid(): Validator<string> {
    return v.string({
      pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    });
  },

  /** One of a closed set — including a Prisma enum, whose members are strings. */
  enumOf<const T extends readonly string[]>(members: T): Validator<T[number]> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "string" || !members.includes(value))
          return fail(issues, path, `must be one of: ${members.join(", ")}`);
        return value as T[number];
      },
    };
  },

  array<T>(item: Validator<T>, opts: { min?: number; max?: number } = {}): Validator<T[]> {
    return {
      parse(value, path, issues) {
        if (!Array.isArray(value)) return fail(issues, path, "must be an array");
        if (opts.min !== undefined && value.length < opts.min)
          return fail(issues, path, `must have at least ${opts.min} items`);
        if (opts.max !== undefined && value.length > opts.max)
          return fail(issues, path, `must have at most ${opts.max} items`);
        return value.map((el, i) => item.parse(el, `${path}[${i}]`, issues));
      },
    };
  },

  object<S extends Shape>(shape: S): Validator<Infer<S>> {
    return {
      parse(value, path, issues) {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return fail(issues, path, "must be an object");
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(shape)) {
          const childPath = path ? `${path}.${key}` : key;
          out[key] = shape[key].parse(source[key], childPath, issues);
        }
        return out as Infer<S>;
      },
    };
  },

  /** Absent or null is fine; present means it must be valid. */
  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return {
      parse(value, path, issues) {
        if (value === undefined || value === null) return undefined;
        return inner.parse(value, path, issues);
      },
    };
  },

  withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
    return {
      parse(value, path, issues) {
        if (value === undefined || value === null) return fallback;
        return inner.parse(value, path, issues);
      },
    };
  },
};

/**
 * Run a validator outside a route — over a query string, a seed file, a job
 * payload. Throws `ApiError.validation` with every problem it found.
 */
export function parseOrThrow<T>(validator: Validator<T>, value: unknown, path = ""): T {
  const issues: FieldIssue[] = [];
  const parsed = validator.parse(value, path, issues);
  if (issues.length) throw ApiError.validation(issues);
  return parsed;
}

/**
 * `+91XXXXXXXXXX` or `null`. Deliberately narrow: it accepts an Indian mobile
 * with or without a country code and any other E.164 number written in full.
 * A number it cannot confidently normalise is rejected rather than stored in
 * whatever form it arrived in, because two spellings of one phone are two
 * accounts.
 */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[\s()\-.]/g, "");
  const plus = digits.startsWith("+");
  const bare = (plus ? digits.slice(1) : digits).replace(/^0+/, "");
  if (!/^\d+$/.test(bare)) return null;

  // A bare 10-digit Indian mobile. The leading digit is 6–9 for every mobile
  // series TRAI has allocated, which is also what stops a landline STD number
  // from being read as one.
  if (!plus && bare.length === 10) {
    if (!/^[6-9]/.test(bare)) return null;
    return `+91${bare}`;
  }
  if (bare.length === 12 && bare.startsWith("91") && /^[6-9]/.test(bare.slice(2))) {
    return `+91${bare.slice(2)}`;
  }
  if (plus && bare.length >= 8 && bare.length <= 15) return `+${bare}`;
  return null;
}

// ---------------------------------------------------------------------------
// The route wrapper
// ---------------------------------------------------------------------------

/**
 * `"any"` means any signed-in user; a role or list of roles means that role.
 * Omitting `auth` entirely makes the route public, which is a decision you have
 * to make in writing — there is no default that quietly lets everyone in.
 */
export type AuthSpec = "any" | UserRole | UserRole[];

export interface RouteContext<B> {
  req: NextRequest;
  /** Present iff the spec declared a `body` validator. */
  body: B;
  /**
   * The acting user, loaded from the database using the id in the session
   * cookie. Never from the request. `undefined` only on a public route.
   */
  user: User;
  /** Convenience: `user.scopeId`. The tenant. Also never from the request. */
  scopeId: string;
  session: Session;
  /** Present iff the spec set `idempotent: true`. */
  idempotencyKey: string;
  /** Dynamic route segments, already awaited. */
  params: Record<string, string | string[]>;
  requestId: string;
}

export interface RouteSpec<B> {
  auth?: AuthSpec;
  body?: Validator<B>;
  /**
   * Demand an `Idempotency-Key` request header and expose it as
   * `ctx.idempotencyKey`. Set this on every mutation that costs money, creates
   * a ticket, or writes a row a duplicate of which would be visible to a
   * student. See `createOnce` below for what to do with the key.
   */
  idempotent?: boolean;
}

type NextRouteArgs = { params: Promise<Record<string, string | string[]>> };

/**
 * Wrap a handler. The return value is what Next.js expects to be exported as
 * `GET` / `POST` / …:
 *
 * ```ts
 * export const POST = route(
 *   { auth: "STUDENT", body: v.object({ paperSlug: v.string({ max: 120 }) }), idempotent: true },
 *   async ({ user, body, idempotencyKey }) => {
 *     // user.id is the student. There is no other student this can be.
 *     return { submissionId: "..." };
 *   },
 * );
 * ```
 *
 * Return a plain value and it is serialised as `200 {json}`. Return a
 * `NextResponse` and it is passed through untouched, which is how you set a
 * cookie or a 201.
 */
export function route<B = undefined>(
  spec: RouteSpec<B>,
  handler: (ctx: RouteContext<B>) => Promise<unknown>,
): (req: NextRequest, args?: NextRouteArgs) => Promise<NextResponse> {
  return async (req: NextRequest, args?: NextRouteArgs) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    try {
      // Auth first. A body validation message must not tell an anonymous
      // caller anything about the shape of a route they may not call.
      let user: User = undefined as unknown as User;
      let session: Session = undefined as unknown as Session;
      if (spec.auth) {
        const role = spec.auth === "any" ? undefined : spec.auth;
        const resolved = await requireUser(role);
        user = resolved.user;
        session = resolved.session;
      } else {
        const maybe = await getSession();
        if (maybe) session = maybe;
      }

      let idempotencyKey = "";
      if (spec.idempotent) {
        const key = req.headers.get("idempotency-key")?.trim() ?? "";
        if (!key) {
          throw new ApiError(
            "IDEMPOTENCY_KEY_REQUIRED",
            "This request must carry an Idempotency-Key header. Generate one per logical action and reuse it on every retry.",
          );
        }
        if (key.length > 64) {
          throw ApiError.validation([
            { path: "Idempotency-Key", message: "must be at most 64 characters" },
          ]);
        }
        idempotencyKey = key;
      }

      let body: B = undefined as B;
      if (spec.body) {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          throw ApiError.validation([{ path: "", message: "body must be valid JSON" }]);
        }
        body = parseOrThrow(spec.body, raw);
      }

      const params = args ? await args.params : {};

      const result = await handler({
        req,
        body,
        user,
        scopeId: user?.scopeId,
        session,
        idempotencyKey,
        params,
        requestId,
      });

      if (result instanceof NextResponse) {
        result.headers.set("x-request-id", requestId);
        return result;
      }
      if (result instanceof Response) {
        const passthrough = new NextResponse(result.body, result);
        passthrough.headers.set("x-request-id", requestId);
        return passthrough;
      }
      return NextResponse.json(result ?? { ok: true }, {
        headers: { "x-request-id": requestId },
      });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err, requestId);
      // Anything else is a bug. Log it whole; return nothing of it. A stack
      // trace or a Prisma message can carry a column name, a query, or a
      // connection string, and none of those are the caller's business.
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} [${requestId}]`, err);
      return errorResponse(
        new ApiError("INTERNAL", "Something went wrong on our end."),
        requestId,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * True when `err` is a Postgres unique-violation surfaced by Prisma, optionally
 * only for a named constraint or column.
 *
 * Prisma reports the *index* name in `meta.target` on Postgres, which for a
 * `@@unique([studentId, idempotencyKey])` is
 * `submissions_studentId_idempotencyKey_key`. Passing a fragment of that is how
 * you avoid catching an unrelated collision and returning the wrong row.
 */
export function isUniqueViolation(err: unknown, targetContains?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== "P2002") return false;
  if (!targetContains) return true;
  const target = err.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes(targetContains);
}

export interface CreateOnceResult<T> {
  row: T;
  /** False means this was a retry and nothing new was written. */
  created: boolean;
}

/**
 * Insert-or-return-the-existing-one, resolved by the database rather than by a
 * read-then-write.
 *
 * A phone on a patchy network retries a POST it never saw the answer to. If the
 * first attempt reached us, the retry must not create a second submission — the
 * student is charged twice and shown two contradictory grades for one answer
 * sheet. Checking "does it exist?" before inserting does not fix this: two
 * retries arriving 30 ms apart both read nothing and both insert.
 *
 * So: insert, and let the unique index decide. `@@unique([studentId,
 * idempotencyKey])` on `Submission` and `submissionId @unique` on
 * `EvaluationTicket` exist for exactly this. On a violation we read back what
 * the winner wrote and return it, so both requests get the same answer.
 *
 * ```ts
 * const { row, created } = await createOnce({
 *   constraint: "idempotencyKey",
 *   create: () => prisma.submission.create({ data: { studentId: user.id, idempotencyKey, ... } }),
 *   find: () => prisma.submission.findUnique({
 *     where: { studentId_idempotencyKey: { studentId: user.id, idempotencyKey } },
 *   }),
 * });
 * ```
 *
 * `find` must be scoped to the acting user, the way the unique itself is. A
 * `find` that looks the key up globally would hand one student another
 * student's row whenever two of them generated the same key — which is not
 * hypothetical, because clients generate keys and some client will use a
 * counter.
 */
export async function createOnce<T>(opts: {
  create: () => Promise<T>;
  find: () => Promise<T | null>;
  /** Fragment of the unique index name to match, e.g. `"idempotencyKey"`. */
  constraint?: string;
}): Promise<CreateOnceResult<T>> {
  try {
    return { row: await opts.create(), created: true };
  } catch (err) {
    if (!isUniqueViolation(err, opts.constraint)) throw err;
    const existing = await opts.find();
    if (!existing) {
      // The unique fired but the row is not where `find` looks. That means the
      // two disagree about which constraint they are about — a bug worth
      // surfacing rather than papering over with a retry loop.
      throw new ApiError(
        "CONFLICT",
        "This key is already in use by a different record.",
      );
    }
    return { row: existing, created: false };
  }
}

/**
 * The narrower guard for a key that must not be reused for *different* content:
 * same key, different request, is a client bug and returning the first row
 * would silently discard the second request's data.
 *
 * `matches` is given the existing row and decides whether the retry is really a
 * retry. Use it wherever the request body carries something the stored row
 * records — a page count, an amount — and answering "yes, done" to a different
 * body would lose a real request.
 */
export async function createOnceStrict<T>(opts: {
  create: () => Promise<T>;
  find: () => Promise<T | null>;
  matches: (existing: T) => boolean;
  constraint?: string;
}): Promise<CreateOnceResult<T>> {
  const result = await createOnce(opts);
  if (!result.created && !opts.matches(result.row)) {
    throw new ApiError(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different request. Generate a new key for a new action.",
    );
  }
  return result;
}
