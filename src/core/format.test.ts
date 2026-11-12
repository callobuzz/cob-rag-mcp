import { describe, expect, it } from "vitest";
import { formatTable, keyValues, pageFooter, sourceLabel, table, truncate } from "./format.js";

describe("CLI formatting", () => {
	it("labels sources without repeating a record's title", () => {
		expect(sourceLabel({ file_name: "Fasting", external_id: "faq-1", section: "Fasting" })).toBe("Fasting [faq-1]");
		expect(sourceLabel({ file_name: "prep.pdf", section: "Lipids > Fasting", page: 3 })).toBe(
			"prep.pdf > Lipids > Fasting > p. 3",
		);
		expect(sourceLabel({ external_id: "faq-2" })).toBe("faq-2");
	});

	it("says which page a list is and how to get the next", () => {
		expect(pageFooter("corpora", { count: 3, total: 3, offset: 0 })).toBe("3 corpora");
		expect(pageFooter("corpora", { count: 2, total: 5, offset: 0 }, "--offset", "--all")).toBe(
			"corpora 1-2 of 5. More: --offset 2, or --all for every page",
		);
		expect(pageFooter("job(s)", { count: 1, total: 5, offset: 4 })).toBe("job(s) 5-5 of 5");
		expect(pageFooter("job(s)", { count: 0, total: 0 })).toBe("0 job(s)");
		expect(pageFooter("job(s)", { count: 0, total: 3, offset: 10 })).toBe("No job(s) at offset 10 (3 in all).");
		expect(pageFooter("chunk(s)", { count: 50, total: 120, offset: 50 }, "--chunk-offset")).toBe(
			"chunk(s) 51-100 of 120. More: --chunk-offset 100",
		);
	});

	it("aligns tables and truncates long cells", () => {
		expect(formatTable(["a", "bb"], [["1", "2"]])).toBe("a  bb\n-  --\n1  2");
		expect(table([], [{ key: "x" }])).toBe("(none)");
		expect(truncate("x".repeat(100), 10)).toBe("xxxxxxx...");
		expect(keyValues({ kind: "corpus", corpus_id: null })).toBe("kind       corpus\ncorpus_id  -");
	});
});
