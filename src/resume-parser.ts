import { createHash } from "node:crypto";
import {
  ProfileSchema,
  type Profile,
  type RecordKind,
  type Value,
} from "./types.js";

const date = String.raw`(?:19|20)\d{2}(?:[./年-](?:1[0-2]|0?[1-9])月?(?:[./-](?:3[01]|[12]\d|0?[1-9])日?)?)?(?!\d)`;
const rangePattern = new RegExp(
  `(${date})\\s*(?:[-–—~～至]|到)\\s*(${date}|至\\s*今|现在|present|current)`,
  "i",
);
const normalizeDate = (s: string) => {
  if (/至\s*今|现在|present|current/i.test(s)) return "至今";
  const m = s.match(
    /((?:19|20)\d{2})(?:[./年-](\d{1,2})月?(?:[./-](\d{1,2}))?)?/,
  )!;
  return m[2]
    ? `${m[1]}-${m[2].padStart(2, "0")}${m[3] ? `-${m[3].padStart(2, "0")}` : ""}`
    : m[1]!;
};
const compact = (s: string) =>
  s.normalize("NFKC").replace(/\s/g, "").toLowerCase();
const sections: [RecordKind | "skills" | "links" | "other", RegExp][] = [
  [
    "education",
    /^(教育经历|教育背景|学习经历|教育信息|education(?:background)?)$/i,
  ],
  [
    "experience",
    /^(实习经历|工作经历|工作经验|工作[\/与和及]实习经历|实习[\/与和及]工作经历|实习经验|professionalexperience|workexperience|internshipexperience|employment)$/i,
  ],
  [
    "project",
    /^(个人项目|项目经历|项目经验|科研项目|项目实践|projects?|projectexperience|personalprojects)$/i,
  ],
  [
    "skills",
    /^(专业技能|技术技能|技术栈|技能|技能特长|technicalskills|skills)$/i,
  ],
  [
    "links",
    /^(开源与技术实践|开源贡献|开源经历|开源项目|个人作品|作品集|opensource|publications)$/i,
  ],
  [
    "other",
    /^(自我评价|个人评价|荣誉奖项|获奖经历|证书|校园经历|兴趣爱好|其他信息|summary|awards|certifications)$/i,
  ],
];
export function resumeSection(line: string) {
  return sections.find(([, re]) =>
    re.test(compact(line).replace(/[:：]$/, "")),
  )?.[0];
}
function add(p: Profile, key: string, values: Value[], source?: string) {
  const unique = [
    ...new Map(values.map((v) => [JSON.stringify(v), v])).values(),
  ];
  p.facts[key] = {
    state:
      unique.length === 0
        ? "missing"
        : unique.length === 1
          ? "pending"
          : "conflict",
    ...(unique.length === 1
      ? { value: unique[0] }
      : unique.length > 1
        ? { candidates: unique }
        : {}),
    discloseTo: [],
    ...(source ? { source: { text: source.slice(0, 2000) } } : {}),
  };
}
function cleanHeader(s: string) {
  return s
    .replace(rangePattern, "")
    .replace(/^[\s|｜·•—-]+|[\s|｜·•—-]+$/g, "")
    .trim();
}
function joinBody(lines: string[]) {
  let result = "";
  for (const line of lines) {
    const paragraph =
      /^(?:参与|负责|针对|通过|基于|为验证|项目)|^[^:：\n]{1,28}[:：]|^[•●▪]/.test(
        line,
      );
    const wrappedChinese =
      /\p{Script=Han}$/u.test(result) && /^\p{Script=Han}/u.test(line);
    result += (!result ? "" : wrappedChinese && !paragraph ? "" : "\n") + line;
  }
  return result.trim();
}
interface Entry {
  header: string;
  lines: string[];
}
function entries(lines: string[], kind: RecordKind): Entry[] {
  const out: Entry[] = [];
  let pendingDate = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!line) continue;
    const hasRange = rangePattern.test(line);
    const title = cleanHeader(line);
    // Dates in a separate column may be emitted immediately before a title.
    if (hasRange && !title) {
      if (out.length && !out.at(-1)!.lines.some((l) => rangePattern.test(l)))
        out.at(-1)!.lines.push(line);
      else pendingDate = line;
      continue;
    }
    const headerLike =
      line.length <= 180 &&
      !/^[•●▪]|^(?:参与|负责|针对|通过|基于|为验证)/.test(line) &&
      (kind === "education"
        ? /大学|学院|学校|University|College|Institute/i.test(line)
        : kind === "experience"
          ? /[|｜]/.test(line) ||
            (hasRange && title.length > 0) ||
            /^(?:公司(?:名称)?|实习单位|工作单位)\s*[:：]/.test(line)
          : (hasRange && title.length > 0) ||
            /^(?:项目名称|项目名)\s*[:：]/.test(line));
    const projectTitle =
      kind === "project" && !out.length && line.length < 90 && !hasRange;
    if (headerLike || projectTitle) {
      if (pendingDate) {
        line += `  ${pendingDate}`;
        pendingDate = "";
      }
      out.push({ header: line, lines: [line] });
    } else if (out.length) out.at(-1)!.lines.push(line);
  }
  return out;
}
function parseEntries(p: Profile, lines: string[], kind: RecordKind) {
  for (const entry of entries(lines, kind)) {
    const ranges = entry.lines
      .map((s) => s.match(rangePattern))
      .filter((m) => m !== null);
    const header = cleanHeader(entry.header);
    const pieces = header
      .split(/\s*[|｜]\s*|\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    const fields: Record<string, string> = {};
    if (kind === "education") {
      const school =
        header.match(/(?:学校(?:名称)?|毕业院校)\s*[:：]\s*([^|｜]+)/)?.[1] ||
        header.match(
          /^(.+?(?:大学|学院|学校|University|College|Institute(?: of [\w ]+)?))(?=\s|[（(|｜]|$)/i,
        )?.[1];
      if (!school) continue;
      fields.school = school.trim();
      const rest =
        header
          .slice(header.indexOf(school) + school.length)
          .replace(/^\s*\((?:211|985|双一流)\)\s*/, "")
          .replace(/^[|｜\s]+/, "") ||
        entry.lines
          .slice(1)
          .find(
            (s) =>
              s.length < 90 && /本科|专科|硕士|博士|Bachelor|Master/i.test(s),
          ) ||
        "";
      const qualification = rest.match(
        /博士研究生|硕士研究生|本科|大专|专科|高中|硕士|博士|Bachelor(?:'s)?|Master(?:'s)?|Ph\.?D\.?/i,
      )?.[0];
      if (qualification) fields.qualification = qualification;
      const major = rest
        .replace(
          /博士研究生|硕士研究生|本科|大专|专科|高中|硕士|博士|Bachelor(?:'s)?|Master(?:'s)?|Ph\.?D\.?/gi,
          "",
        )
        .replace(/学士|学位/g, "")
        .replace(/^[|｜\s]+|[|｜\s]+$/g, "");
      if (major) fields.major = major;
      // A qualification does not prove a degree has been awarded.
      const degree = rest.match(
        /(?:工学|理学|文学|管理学|经济学|法学)?(?:学士|硕士学位|博士学位)/,
      )?.[0];
      if (degree) fields.degree = degree;
    } else {
      fields[kind === "project" ? "name" : "company"] = pieces[0]!.replace(
        /^(?:公司(?:名称)?|实习单位|工作单位|项目名称|项目名)\s*[:：]\s*/,
        "",
      );
      if (pieces[1])
        fields[kind === "project" ? "role" : "title"] = pieces
          .slice(1)
          .join(" ");
    }
    const labels: Record<string, RegExp> =
      kind === "education"
        ? {
            school: /^(?:学校名称|学校|毕业院校)\s*[:：]\s*(.+)$/,
            major: /^(?:专业名称|所学专业|专业)\s*[:：]\s*(.+)$/,
            qualification: /^(?:学历|学历层次)\s*[:：]\s*(.+)$/,
            degree: /^学位\s*[:：]\s*(.+)$/,
          }
        : kind === "experience"
          ? {
              company: /^(?:公司名称|公司|实习单位|工作单位)\s*[:：]\s*(.+)$/,
              title: /^(?:岗位名称|职位名称|职位|职务|岗位)\s*[:：]\s*(.+)$/,
            }
          : {
              name: /^(?:项目名称|项目名)\s*[:：]\s*(.+)$/,
              role: /^(?:项目角色|担任角色|角色)\s*[:：]\s*(.+)$/,
            };
    for (const [key, re] of Object.entries(labels)) {
      const explicit = entry.lines
        .map((line) => line.match(re)?.[1])
        .filter((v) => v !== undefined);
      if (explicit.length === 1) fields[key] = cleanHeader(explicit[0]!);
    }
    const first = ranges[0];
    const namedStart = entry.lines
      .map(
        (line) =>
          line.match(
            new RegExp(
              `^(?:开始时间|开始日期|入学时间|入职时间)\\s*[:：]\\s*(${date})$`,
            ),
          )?.[1],
      )
      .find(Boolean);
    const identity = [
      kind,
      fields.school || fields.company || fields.name,
      fields.major || fields.title || "",
      first
        ? normalizeDate(first[1]!)
        : namedStart
          ? normalizeDate(namedStart)
          : "",
    ]
      .map((s) => compact(s))
      .join("|");
    const id = `auto_${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
    // Reimporting the same source identity must not create duplicate records.
    if (p.records[kind].includes(id)) continue;
    p.records[kind].push(id);
    const base = `${kind}.${id}`;
    for (const [key, value] of Object.entries(fields))
      if (value) add(p, `${base}.${key}`, [value], entry.header);
    for (const [key, index] of [
      ["startDate", 1],
      ["endDate", 2],
    ] as const) {
      const label =
        index === 1
          ? "开始时间|开始日期|入学时间|入职时间"
          : "结束时间|结束日期|毕业时间|离职时间";
      const named = entry.lines
        .map((s) =>
          s.match(
            new RegExp(
              `^(?:${label})\\s*[:：]\\s*(${date}|至今|present)$`,
              "i",
            ),
          ),
        )
        .filter((m) => m !== null);
      add(
        p,
        `${base}.${key}`,
        [
          ...ranges.map((m) => normalizeDate(m[index]!)),
          ...named.map((m) => normalizeDate(m[1]!)),
        ],
        [...ranges.map((m) => m[0]), ...named.map((m) => m[0])].join("\n"),
      );
    }
    if (first?.[2] && normalizeDate(first[2]) === "至今")
      add(p, `${base}.current`, [true], first[0]);
    const body = entry.lines
      .slice(1)
      .filter((line) => !rangePattern.test(line) || cleanHeader(line));
    if (body.length)
      add(p, `${base}.description`, [joinBody(body)], entry.header);
    if (kind === "project") {
      const responsibility = body.filter((line) =>
        /^(项目职责|个人职责|担任角色|负责内容)\s*[:：]/.test(line),
      );
      if (responsibility.length)
        add(
          p,
          `${base}.responsibilities`,
          [
            joinBody(responsibility).replace(
              /^(项目职责|个人职责|担任角色|负责内容)\s*[:：]\s*/,
              "",
            ),
          ],
          entry.header,
        );
    }
  }
}

export function parseResumeText(input: string): Profile {
  const text = input
    .normalize("NFKC")
    .replace(/\r/g, "")
    .replace(/至\s+今/g, "至今");
  const lines = text.split("\n").map((s) => s.trim());
  const p = ProfileSchema.parse({});
  add(
    p,
    "basic.email",
    text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [],
  );
  add(
    p,
    "basic.phone",
    text.match(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g) ?? [],
  );
  const names = [
    ...text.matchAll(/(?:姓名|Name)\s*[:：]\s*([^\n\r|｜]+)/gi),
  ].map((m) => m[1]!.trim());
  if (
    !names.length &&
    (p.facts["basic.email"]?.value || p.facts["basic.phone"]?.value)
  ) {
    const headingName = lines
      .slice(0, 4)
      .map((s) => s.split(/\s{2,}/)[0]!)
      .find(
        (s) =>
          /^[\p{Script=Han}]{2,4}$/u.test(s) &&
          !resumeSection(s) &&
          !/简历|信息|经历|技能|求职|项目/.test(s),
      );
    if (headingName) names.push(headingName);
  }
  add(p, "basic.name", names);
  const firstSection = lines.findIndex((s) => !!resumeSection(s));
  const heading = lines.slice(0, firstSection < 0 ? 8 : firstSection);
  const intention = heading.find(
    (s) =>
      /^(求职意向|意向岗位)\s*[:：]/.test(s) ||
      (/开发|工程师|设计师|产品经理/.test(s) &&
        s.length < 60 &&
        !/公司|学校|大学|学院/.test(s)),
  );
  if (intention)
    add(
      p,
      "preference.role",
      [intention.replace(/^(求职意向|意向岗位)\s*[:：]\s*/, "")],
      intention,
    );
  const github = heading
    .join("\n")
    .match(/(?:https?:\/\/)?github\.com\/[\w.-]+(?:\/[\w.-]+)?/i)?.[0];
  if (github)
    add(p, "basic.github", [
      github.startsWith("http") ? github : `https://${github}`,
    ]);
  let section: ReturnType<typeof resumeSection>;
  let buffer: string[] = [];
  const flush = () => {
    if (
      section === "education" ||
      section === "experience" ||
      section === "project"
    )
      parseEntries(p, buffer, section);
    if (section === "skills" && buffer.length)
      add(p, "skills.description", [joinBody(buffer)]);
    if (section === "links" && buffer.length)
      add(p, "portfolio.description", [buffer.join("\n")]);
    buffer = [];
  };
  for (const line of lines) {
    const next = resumeSection(line);
    if (next) {
      flush();
      section = next;
    } else if (section && line) buffer.push(line);
  }
  flush();
  return p;
}
