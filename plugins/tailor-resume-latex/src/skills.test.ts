import { describe, expect, it } from 'vitest';
import { extractItemCatalogue, validateSkillsLatex } from './skills.js';

const ORIGINAL = `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{Languages}{: JavaScript, TypeScript, Python, Java, SQL} \\\\
     \\textbf{Frameworks \\& Libraries}{: React, Vue 3, Node.js, Fastify} \\\\
     \\textbf{Databases \\& Cloud}{: PostgreSQL, Redis, AWS}
    }}
\\end{itemize}`;

describe('skills validator', () => {
  it('accepts a reorder within the original catalogue', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{Languages}{: TypeScript, JavaScript, Python} \\\\
     \\textbf{Databases \\& Cloud}{: PostgreSQL, Redis}
    }}
\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(true);
  });

  it('rejects invented items', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{\\textbf{Languages}{: Rust, Go}}}
\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invented items/);
  });

  it('rejects shell-escape and other forbidden tokens', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]\\immediate\\write18{echo pwned}\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown LaTeX commands', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]
     \\textcolor{red}{\\textbf{Languages}{: Python}}
\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/disallowed command/);
  });

  it('rejects fragments that do not open with \\begin{itemize}', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const r = validateSkillsLatex('nothing here', catalogue);
    expect(r.ok).toBe(false);
  });
});
