import { describe, expect, it } from "vitest";
import { validateMotivation } from "./motivation.js";

const posting =
  "Senior Backend Engineer at Acme Fictional Ltd. You will build our billing platform and improve payment reliability for 40 teams.";
const kinds = (t: string) => validateMotivation(t, posting).map((f) => f.kind);

describe("motivation validator", () => {
  it("accepts motivation drawn from the posting", () => {
    expect(
      kinds("I am interested in the role because the team is building a billing platform."),
    ).toEqual([]);
    expect(kinds("The focus on payment reliability appeals to me.")).toEqual([]);
  });

  it.each([
    ["product use", "I've used Acme for years and admire the product."],
    ["customer", "As a long-time customer, I would love to join."],
    ["referral", "I was referred by my friend on the team."],
    ["conversation", "I spoke with your engineering manager last week."],
    ["inflated enthusiasm", "This is my dream job and I am passionate about billing."],
    ["claim of fit", "I am the perfect fit for this role."],
  ])("rejects %s", (_n, text) => {
    expect(kinds(text)).toContain("other");
  });

  it("rejects numbers and names not in the posting", () => {
    expect(kinds("I want to help your 400 teams.")).toContain("unsupported_number");
    expect(kinds("I am interested in helping 40 teams.")).toEqual([]);
    expect(kinds("I am excited about your Kubernetes migration.")).toContain("unsupported_entity");
  });
});
