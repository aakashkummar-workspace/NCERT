/**
 * A small, realistic, deterministic dataset — the fixtures every other lane
 * develops against.
 *
 *     npx tsx prisma/seed.ts
 *
 * ## Deterministic, and why that is not a nicety
 *
 * Every id is derived from a stable name via `id()` below, so the student who
 * is `…-student-aarti` today is the same UUID tomorrow, in your checkout and in
 * mine. That means a curl script in a lane's README can hardcode an id, a smoke
 * test can assert on one, and a screenshot in a pull request still points at
 * something real. Random ids would make every one of those a lie after the next
 * reseed.
 *
 * ## Re-runnable
 *
 * Everything is an upsert keyed on those ids, so running it twice is running it
 * once. It never truncates: another lane will have real work sitting in this
 * database, and a seed that resets the schema is a seed nobody dares run.
 *
 * ## Passwords
 *
 * Every seeded user gets an email and the same known password, so the app can
 * actually be signed into from its own sign-in screen rather than only from a
 * curl script. They are printed at the end of a run. That is a development
 * fixture and nothing else: `seedPasswords()` refuses outright when
 * `NODE_ENV === "production"`, for the same reason `devCodeFor()` does — a
 * published password on every account is not a smaller hole than a published
 * OTP.
 *
 * ## The parent
 *
 * There is no `PARENT` in `UserRole`, and `prisma/README.md` scopes parent links
 * out of Phases 0–4 on purpose. Rather than fabricate one under a role that
 * means something else, this seed does the honest version of the same fixture:
 * **two siblings share their parent's phone number in two different scopes**,
 * which is precisely the case `@@unique([scopeId, phone])` exists to permit and
 * a global unique on phone would have broken. When a parent role lands, that
 * shared number is the join.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";
import { hashPassword, isProduction } from "../src/lib/auth";
import type {
  CriterionKind,
  EvaluatorType,
  MatchMode,
  PartialReason,
  QuestionType,
  RubricOrdering,
  UserRole,
} from "@prisma/client";

const prisma = new PrismaClient({ log: ["warn", "error"] });

const PUBLIC_SCOPE = "00000000-0000-0000-0000-000000000000";
/**
 * A stand-in tenant. Not a `tenants` row — that table does not exist yet — just
 * a second scope value, so that a lane writing a scoped query has something to
 * write it against and something for it to correctly exclude.
 */
const SCHOOL_SCOPE = "11111111-1111-1111-1111-111111111111";

/**
 * One password for every fixture account, printed at the end of a run.
 *
 * The same value each time on purpose, exactly as the ids are: a README, a
 * smoke test and a screenshot can all name it and still be true after the next
 * reseed. Long enough to clear `passwordProblem()` without being a puzzle.
 */
const SEED_PASSWORD = "ncert-dev-2026";

/**
 * A stable UUID from a name. Not RFC 4122 v5 (no namespace ceremony), but the
 * only properties that matter here are "valid UUID" and "same input, same
 * output", and a SHA-256 prefix with the version and variant nibbles fixed has
 * both.
 */
function id(name: string): string {
  const h = createHash("sha256").update(`ncert-seed:${name}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return [h.slice(0, 8), h.slice(8, 12), `5${h.slice(13, 16)}`, `${variant}${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

function log(line: string): void {
  console.log(line);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

interface SeedUser {
  key: string;
  scopeId: string;
  phone: string;
  displayName: string;
  role: UserRole;
  email?: string;
  hitlEnabled?: boolean;
  student?: { classNum: number; schoolName?: string; language?: string };
  evaluator?: {
    evaluatorType: EvaluatorType;
    maxConcurrent?: number;
    activeForRouting?: boolean;
    subjects: Array<{ subject: string; classNum: number }>;
  };
}

/**
 * Phone numbers are all in the `+9198100000xx` block — a real Indian mobile
 * prefix so that `normalisePhone()` accepts them, and a contiguous run so that
 * nobody has to look one up twice.
 */
const USERS: SeedUser[] = [
  {
    key: "student-aarti",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000001",
    email: "aarti.sharma@example.invalid",
    displayName: "Aarti Sharma",
    role: "STUDENT",
    // The one student routed to a human. Any lane testing the evaluator queue
    // wants exactly one of these, or every submission makes a ticket.
    hitlEnabled: true,
    student: { classNum: 10, schoolName: "Kendriya Vidyalaya, Sector 8", language: "en" },
  },
  {
    key: "student-imran",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000002",
    email: "imran.qureshi@example.invalid",
    displayName: "Imran Qureshi",
    role: "STUDENT",
    student: { classNum: 10, schoolName: "Govt. Sr. Sec. School, Nangloi", language: "en" },
  },
  {
    key: "student-devika",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000003",
    email: "devika.nair@example.invalid",
    displayName: "Devika Nair",
    role: "STUDENT",
    // Class 9 is on the new NCF books; Class 10 is not. Having one of each
    // means a lane cannot accidentally hardcode Class 10 and still pass.
    student: { classNum: 9, schoolName: "St. Xavier's, Kochi", language: "en" },
  },
  {
    key: "student-hindi-reader",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000004",
    email: "rohit.yadav@example.invalid",
    displayName: "Rohit Yadav",
    role: "STUDENT",
    // The reader ships Hindi books and 44 of 149 have untitled chapters. A
    // Hindi-language student in the fixtures is how that stops being invisible.
    student: { classNum: 9, schoolName: "Saraswati Vidya Mandir, Patna", language: "hi" },
  },

  // The sibling pair. Same phone — their parent's — in two different scopes.
  // See the header note: this is the parent fixture, expressed in the shape the
  // schema actually has.
  {
    key: "student-sibling-public",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000010",
    email: "kabir.menon@example.invalid",
    displayName: "Kabir Menon",
    role: "STUDENT",
    student: { classNum: 9, schoolName: "Delhi Public School, Rohini" },
  },
  {
    key: "student-sibling-school",
    scopeId: SCHOOL_SCOPE,
    phone: "+919810000010",
    email: "ananya.menon@example.invalid",
    displayName: "Ananya Menon",
    role: "STUDENT",
    student: { classNum: 10, schoolName: "Delhi Public School, Rohini" },
  },

  {
    key: "evaluator-science",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000021",
    displayName: "Meera Iyer",
    email: "meera.iyer@example.invalid",
    role: "EVALUATOR",
    evaluator: {
      evaluatorType: "SCHOOL_TEACHER",
      maxConcurrent: 8,
      subjects: [
        { subject: "Science", classNum: 10 },
        { subject: "Science", classNum: 9 },
      ],
    },
  },
  {
    key: "evaluator-maths",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000022",
    displayName: "Sandeep Rao",
    email: "sandeep.rao@example.invalid",
    role: "EVALUATOR",
    evaluator: {
      evaluatorType: "FREELANCE",
      maxConcurrent: 3,
      // Two evaluators with *disjoint* subjects, so that a routing bug which
      // ignores subject entirely still shows up as the wrong name on a ticket.
      subjects: [
        { subject: "Mathematics", classNum: 10 },
        { subject: "Social Science", classNum: 10 },
      ],
    },
  },
  {
    key: "evaluator-inactive",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000023",
    email: "priya.balan@example.invalid",
    displayName: "Priya Balan",
    role: "EVALUATOR",
    evaluator: {
      evaluatorType: "INTERNAL_TUTOR",
      // Off the queue without being deleted — the case `activeForRouting`
      // exists for, and the one a router is most likely to forget.
      activeForRouting: false,
      subjects: [{ subject: "Science", classNum: 10 }],
    },
  },

  /*
   * Two admins, in two scopes, because an admin is an admin *of a scope* and
   * every admin-only route filters by `user.scopeId`.
   *
   * Vikram was the only one, and he is in the school scope while every seeded
   * student is in the public one. That made `POST /api/tickets/dispatch/` —
   * ADMIN-only, and scope-bound through the submission's own student —
   * unreachable for every fixture on the platform: nobody could route a seeded
   * student's script to a human, which is the first step of the whole
   * human-review journey. Suites were provisioning a public-scope admin of
   * their own to get past it.
   *
   * Nisha is that admin, seeded. Vikram stays exactly as he was: he is the
   * fixture that proves the boundary holds, and a suite that asserts he *cannot*
   * see public-scope work is asserting the right thing.
   */
  {
    key: "admin-public",
    scopeId: PUBLIC_SCOPE,
    phone: "+919810000030",
    displayName: "Nisha Verma",
    email: "nisha.verma@example.invalid",
    role: "ADMIN",
  },
  {
    key: "admin-school",
    scopeId: SCHOOL_SCOPE,
    phone: "+919810000031",
    displayName: "Vikram Desai",
    email: "principal@dps-rohini.example.invalid",
    role: "ADMIN",
  },
];

async function seedUsers(): Promise<void> {
  for (const u of USERS) {
    const userId = id(u.key);
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        scopeId: u.scopeId,
        phone: u.phone,
        email: u.email ?? null,
        displayName: u.displayName,
        role: u.role,
        hitlEnabled: u.hitlEnabled ?? false,
      },
      update: {
        scopeId: u.scopeId,
        phone: u.phone,
        email: u.email ?? null,
        displayName: u.displayName,
        role: u.role,
        hitlEnabled: u.hitlEnabled ?? false,
      },
    });

    if (u.student) {
      await prisma.studentProfile.upsert({
        where: { userId },
        create: {
          id: id(`${u.key}:student-profile`),
          userId,
          classNum: u.student.classNum,
          schoolName: u.student.schoolName ?? null,
          language: u.student.language ?? "en",
        },
        update: {
          classNum: u.student.classNum,
          schoolName: u.student.schoolName ?? null,
          language: u.student.language ?? "en",
        },
      });
    }

    if (u.evaluator) {
      const profileId = id(`${u.key}:evaluator-profile`);
      await prisma.evaluatorProfile.upsert({
        where: { userId },
        create: {
          id: profileId,
          userId,
          evaluatorType: u.evaluator.evaluatorType,
          maxConcurrent: u.evaluator.maxConcurrent ?? 5,
          activeForRouting: u.evaluator.activeForRouting ?? true,
        },
        update: {
          evaluatorType: u.evaluator.evaluatorType,
          maxConcurrent: u.evaluator.maxConcurrent ?? 5,
          activeForRouting: u.evaluator.activeForRouting ?? true,
        },
      });

      for (const s of u.evaluator.subjects) {
        await prisma.evaluatorSubject.upsert({
          where: {
            evaluatorProfileId_subject_classNum: {
              evaluatorProfileId: profileId,
              subject: s.subject,
              classNum: s.classNum,
            },
          },
          create: {
            id: id(`${u.key}:subject:${s.subject}:${s.classNum}`),
            evaluatorProfileId: profileId,
            subject: s.subject,
            classNum: s.classNum,
          },
          update: {},
        });
      }
    }
  }

  log(`  users            ${USERS.length}`);
}

/**
 * Give every fixture account the same known password.
 *
 * Separate from `seedUsers()` because it is the one part of this file that must
 * not run everywhere. `isProduction()` is the same guard `devCodeFor()` uses,
 * and for the same reason: a published password on every account is not a
 * smaller hole than a published one-time code.
 *
 * Hashed per user rather than once and copied, so the fixtures look like real
 * rows — different salts, different hashes, one password. Re-hashed on every run
 * rather than skipped when a hash is already there: what this prints has to be
 * true, and an account whose password someone changed by hand would otherwise
 * silently stop matching the line at the end of the output. A new salt for the
 * same password is the same password.
 */
async function seedPasswords(): Promise<void> {
  if (isProduction()) {
    log("  passwords        skipped — NODE_ENV is production");
    return;
  }
  for (const u of USERS) {
    await prisma.user.update({
      where: { id: id(u.key) },
      data: { passwordHash: await hashPassword(SEED_PASSWORD) },
    });
  }
  log(`  passwords        ${USERS.length} set to the development password`);
}

// ---------------------------------------------------------------------------
// Rubrics, loaded from data/rubrics.json
// ---------------------------------------------------------------------------

/**
 * The authoring format. `data/rubrics.schema.md` is the contract; this mirrors
 * only the fields the tables have columns for.
 */
interface JsonConcept {
  any: string[];
}
interface JsonOption {
  id: string;
  awardFor: string;
  keywords?: JsonConcept[];
  tags?: string[];
}
interface JsonStep {
  id: string;
  kind?: "step" | "choose" | "diagram" | "alternatives";
  awardFor: string;
  marks?: number;
  marksEach?: number;
  chooseAtLeast?: number;
  keywords?: JsonConcept[];
  options?: JsonOption[];
  partial?: Array<{ when: string; award: number; note?: string }>;
  unit?: { required?: boolean; accepted?: string[] };
  requireTags?: Record<string, number>;
  labels?: string[];
  match?: "all" | "any";
  ordered?: boolean;
  autoGradable?: boolean;
  alternatives?: unknown[];
}
interface JsonRubric {
  id: string;
  paper: string;
  session?: string;
  questionNo: number;
  variant?: string;
  type: string;
  maxMarks: number;
  bookCode: string;
  chapter: number;
  class: number;
  subject: string;
  prompt?: string;
  ordering?: "ordered" | "unordered";
  acceptEquivalentWording?: boolean;
  needsReview?: boolean;
  reviewNotes?: string[];
  scheme?: { file?: string; page?: number };
  steps: JsonStep[];
}

const QUESTION_TYPES: Record<string, QuestionType> = {
  mcq: "MCQ",
  "assertion-reason": "ASSERTION_REASON",
  vsa: "VSA",
  sa: "SA",
  la: "LA",
  "case-study": "CASE_STUDY",
};

const PARTIAL_REASONS: Record<string, PartialReason> = {
  "unit-missing": "UNIT_MISSING",
  "unit-wrong": "UNIT_WRONG",
  "order-broken": "ORDER_BROKEN",
  "keywords-partial": "KEYWORDS_PARTIAL",
  "arithmetic-slip": "ARITHMETIC_SLIP",
  "formula-only": "FORMULA_ONLY",
  "sign-error": "SIGN_ERROR",
  unrounded: "UNROUNDED",
};

async function seedRubrics(): Promise<void> {
  const file = path.resolve(process.cwd(), "data/rubrics.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { rubrics: JsonRubric[] };

  let loaded = 0;
  const skipped: string[] = [];

  for (const r of parsed.rubrics) {
    // `kind: "alternatives"` — CBSE's "answer either printed alternative" — is
    // a nested tree this flat writer cannot build. It is no longer unstorable:
    // `CriterionKind` gained ALTERNATIVES and BRANCH, `branchLabel` exists, and
    // the CHECK constraints were widened to admit them. But loading it *here*
    // and lossily would put a rubric in the database whose steps do not sum to
    // its maxMarks, and every attempt at that question would then be graded out
    // of the wrong denominator. So it is still skipped here and imported by
    // `importRubricsFromFile()` below, which builds the tree properly and
    // derives identical ids — running both is running one.
    if (r.steps.some((s) => s.kind === "alternatives" || s.alternatives)) {
      skipped.push(r.id);
      continue;
    }

    const rubricId = id(`rubric:${r.id}:1`);
    const data = {
      externalId: r.id,
      paperSlug: r.paper,
      questionNumber: r.questionNo,
      // Empty string, not NULL: NULLs are distinct in Postgres, so a nullable
      // variant would let two rubrics for the same un-varianted question sit
      // side by side. The schema comment says as much.
      variant: r.variant ?? "",
      session: r.session ?? null,
      type: QUESTION_TYPES[r.type] ?? "SA",
      maxMarks: new Prisma.Decimal(r.maxMarks),
      version: 1,
      source: "CBSE_MARKING_SCHEME" as const,
      bookCode: r.bookCode,
      chapter: r.chapter,
      subject: r.subject,
      classNum: r.class,
      prompt: r.prompt ?? null,
      ordering: ((r.ordering ?? "unordered") === "ordered" ? "ORDERED" : "UNORDERED") as RubricOrdering,
      acceptEquivalentWording: r.acceptEquivalentWording ?? true,
      needsReview: r.needsReview ?? false,
      reviewNotes: r.reviewNotes ?? [],
      schemeFile: r.scheme?.file ?? null,
      schemePage: r.scheme?.page ?? null,
    };

    await prisma.rubric.upsert({
      where: { id: rubricId },
      create: { id: rubricId, ...data },
      update: data,
    });

    // Criteria are rebuilt rather than upserted. They are a tree with an
    // ordinal, and reconciling a tree in place means working out what moved;
    // deleting and re-inserting is the same result in a tenth of the code, and
    // nothing points at a `RubricCriterion` except a `CriterionResult` — which
    // this seed never writes.
    await prisma.rubricCriterion.deleteMany({ where: { rubricId } });

    let ordinal = 0;
    for (const step of r.steps) {
      const kind: CriterionKind =
        step.kind === "choose" ? "CHOOSE" : step.kind === "diagram" ? "DIAGRAM" : "STEP";
      const criterionId = id(`criterion:${r.id}:${step.id}`);

      await prisma.rubricCriterion.create({
        data: {
          id: criterionId,
          rubricId,
          stepId: step.id,
          parentId: null,
          ordinal: ordinal++,
          kind,
          awardFor: step.awardFor.slice(0, 300),
          marks: kind === "CHOOSE" ? null : new Prisma.Decimal(step.marks ?? 0),
          marksEach: kind === "CHOOSE" ? new Prisma.Decimal(step.marksEach ?? 0) : null,
          chooseAtLeast: kind === "CHOOSE" ? (step.chooseAtLeast ?? 1) : null,
          match: ((step.match ?? "all") === "any" ? "ANY" : "ALL") as MatchMode,
          unitRequired: step.unit?.required ?? false,
          unitAccepted: step.unit?.accepted ?? [],
          tags: [],
          labels: step.labels ?? [],
          // Forced, not copied. `diagram_not_auto_gradable` in the migration
          // says the same thing in SQL: a keyword matcher run over a photograph
          // cannot honestly say whether a triangle was drawn correctly.
          autoGradable: kind === "DIAGRAM" ? false : (step.autoGradable ?? true),
          ordered: step.ordered ?? null,
          concepts: {
            create: (step.keywords ?? [])
              .filter((c) => c.any?.length)
              .map((c, i) => ({
                id: id(`concept:${r.id}:${step.id}:${i}`),
                ordinal: i,
                phrasings: c.any,
              })),
          },
          partialRules: {
            create: (step.partial ?? [])
              .filter((p) => PARTIAL_REASONS[p.when])
              .map((p) => ({
                id: id(`partial:${r.id}:${step.id}:${p.when}`),
                reason: PARTIAL_REASONS[p.when],
                award: new Prisma.Decimal(p.award),
                note: p.note ?? null,
              })),
          },
          tagDemands: {
            create: Object.entries(step.requireTags ?? {}).map(([tag, minCount]) => ({
              id: id(`tagreq:${r.id}:${step.id}:${tag}`),
              tag,
              minCount,
            })),
          },
        },
      });

      let optionOrdinal = 0;
      for (const option of step.options ?? []) {
        // Qualified with the group, as `g3/o1`, rather than stored bare.
        //
        // The contract scopes an option's id to its group — `check-rubrics.mjs`
        // starts a fresh `seenOptionIds` per choose group — but
        // `@@unique([rubricId, stepId])` scopes it to the whole rubric. Those
        // disagree, and `class10-social-science-2025-26-q28` is where they
        // collide today: two groups in one rubric each numbering their options
        // `o1, o2, o3`.
        //
        // Qualifying always, rather than only on collision, is what keeps the
        // id stable across re-imports: a conditional rule would rename every
        // option in a rubric the day someone adds a second group to it.
        // Reported upstream; see docs/PLATFORM.md.
        const optionStepId = `${step.id}/${option.id}`;
        await prisma.rubricCriterion.create({
          data: {
            id: id(`criterion:${r.id}:${optionStepId}`),
            rubricId,
            stepId: optionStepId,
            parentId: criterionId,
            ordinal: optionOrdinal++,
            kind: "OPTION",
            awardFor: option.awardFor.slice(0, 300),
            // An OPTION carries no marks of its own: the group's `marksEach`
            // is what a satisfied option is worth. `criterion_marks_by_kind`
            // enforces it.
            marks: null,
            marksEach: null,
            chooseAtLeast: null,
            tags: option.tags ?? [],
            // Options are order-free; `option_not_ordered` requires NULL here.
            ordered: null,
            concepts: {
              create: (option.keywords ?? [])
                .filter((c) => c.any?.length)
                .map((c, i) => ({
                  id: id(`concept:${r.id}:${optionStepId}:${i}`),
                  ordinal: i,
                  phrasings: c.any,
                })),
            },
          },
        });
      }
    }

    loaded += 1;
  }

  log(`  rubrics          ${loaded} loaded from data/rubrics.json`);

  // The nested `alternatives` trees this writer skipped, built properly.
  if (skipped.length) {
    const { importRubricsFromFile } = await import("../src/lib/rubric-load");
    const report = await importRubricsFromFile({ only: skipped });
    log(`  rubrics nested   ${report.imported.length} imported as alternatives trees`);
    for (const r of report.rejected) {
      log(`  rubrics REJECTED ${r.id}: ${r.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("\nSeeding…");
  await seedUsers();
  await seedPasswords();
  await seedRubrics();

  const counts = {
    users: await prisma.user.count(),
    students: await prisma.studentProfile.count(),
    evaluators: await prisma.evaluatorProfile.count(),
    rubrics: await prisma.rubric.count(),
    criteria: await prisma.rubricCriterion.count(),
  };
  log(
    `\nDone. users=${counts.users} students=${counts.students} ` +
      `evaluators=${counts.evaluators} rubrics=${counts.rubrics} criteria=${counts.criteria}\n`,
  );
  if (!isProduction()) {
    log(`Sign in at /signin/ with any of these. The password for all of them is: ${SEED_PASSWORD}`);
    log("  aarti.sharma@example.invalid    Aarti Sharma — Class 10 student, HITL on");
    log("  meera.iyer@example.invalid      Meera Iyer — Science evaluator, Class 9 + 10");
    log("  imran.qureshi@example.invalid   Imran Qureshi — Class 10 student");
    log("  devika.nair@example.invalid     Devika Nair — Class 9 student");
    log("  nisha.verma@example.invalid     Nisha Verma — ADMIN in the public scope");
    log("");
    // Vikram is an ADMIN in the school scope, and the sign-in form is
    // public-scope the way all B2C sign-in is here: nothing accepts a tenant
    // from a browser. The development login route is where a scope may be
    // named, and it 404s in production.
    log("Vikram Desai is an ADMIN in the school scope, which the public sign-in form does");
    log("not reach. Use the development login route below for him — or make your own admin");
    log("at /signin/, where the role picker is development-only in the same way.");
    log("");
  }
  log("Sign in as any of them without a code (development only):");
  log(`  curl -X POST localhost:3310/api/dev/login/ -H 'content-type: application/json' \\`);
  log(`       -d '{"phone":"+919810000001"}'   # Aarti, Class 10 student, HITL on`);
  log(`       -d '{"phone":"+919810000021"}'   # Meera, Science evaluator`);
  log(`       -d '{"phone":"+919810000030"}'   # Nisha, public-scope admin`);
  log(`       -d '{"phone":"+919810000031","scopeId":"${SCHOOL_SCOPE}"}'  # Vikram, school admin\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
