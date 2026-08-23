import { describe, expect, it } from "vitest";
import { registryFor } from "../lib/index.js";

/**
 * The registry each ecosystem resolved to under the hand-maintained 16-entry map that
 * 1.2.x shipped. Routing moved to the SDK in 1.3.0; these values must not move with it.
 *
 * `fetchVersionNumbers` returns `[]` for an unresolved ecosystem and the build still
 * exits 0, so a regression here costs an entire ecosystem's version data with nothing
 * failing. This table is the only thing that catches it.
 */
const REGISTRY_BY_ECOSYSTEM: Record<string, string> = {
  npm: "npmjs.org",
  pypi: "pypi.org",
  rubygems: "rubygems.org",
  go: "proxy.golang.org",
  cargo: "crates.io",
  maven: "repo1.maven.org",
  nuget: "nuget.org",
  packagist: "packagist.org",
  hex: "hex.pm",
  pub: "pub.dev",
  hackage: "hackage.haskell.org",
  cocoapods: "cocoapods.org",
  conda: "anaconda.org",
  clojars: "clojars.org",
  puppet: "forge.puppet.com",
  homebrew: "formulae.brew.sh",
};

/**
 * A PURL for each, in the vocabulary the API actually sends. Four of these differ from
 * the ecosystem name -- `gem`, `golang`, `composer`, `brew` -- which is exactly why
 * routing goes through the PURL rather than the `ecosystem` string.
 */
const PURL_BY_ECOSYSTEM: Record<string, string> = {
  npm: "pkg:npm/lodash",
  pypi: "pkg:pypi/requests",
  rubygems: "pkg:gem/rails",
  go: "pkg:golang/github.com%2Fgin-gonic%2Fgin",
  cargo: "pkg:cargo/serde",
  maven: "pkg:maven/org.apache.commons/commons-lang3",
  nuget: "pkg:nuget/Newtonsoft.Json",
  packagist: "pkg:composer/laravel/framework",
  hex: "pkg:hex/phoenix",
  pub: "pkg:pub/http",
  hackage: "pkg:hackage/aeson",
  cocoapods: "pkg:cocoapods/AFNetworking",
  conda: "pkg:conda/numpy",
  clojars: "pkg:clojars/ring",
  puppet: "pkg:puppet/puppetlabs/stdlib",
  homebrew: "pkg:brew/wget",
};

describe("registryFor", () => {
  it.each(Object.entries(REGISTRY_BY_ECOSYSTEM))(
    "resolves %s by purl to the registry 1.2.x used",
    (ecosystem, expected) => {
      const purl = PURL_BY_ECOSYSTEM[ecosystem];

      expect(registryFor({ ecosystem, purl })).toBe(expected);
    },
  );

  it("resolves every ecosystem the 1.2.x map covered", () => {
    // Asserted as a set as well as per-case: a silently dropped entry above would
    // otherwise just stop being tested.
    const unresolved = Object.entries(PURL_BY_ECOSYSTEM).filter(
      ([ecosystem, purl]) => registryFor({ ecosystem, purl }) === null,
    );

    expect(unresolved).toEqual([]);
    expect(Object.keys(PURL_BY_ECOSYSTEM).sort()).toEqual(
      Object.keys(REGISTRY_BY_ECOSYSTEM).sort(),
    );
  });

  describe("the ecosystem fallback", () => {
    it.each(Object.entries(REGISTRY_BY_ECOSYSTEM))(
      "resolves %s from the name alone",
      (ecosystem, expected) => {
        // `fetchVersionNumbers(ecosystem, name)` is a public export and has no purl to
        // work with, so the fallback has to cover everything 1.2.x's map covered.
        expect(registryFor({ ecosystem })).toBe(expected);
      },
    );

    it("translates the four names that are not purl types", () => {
      // The SDK's table is keyed by purl type; twelve of the sixteen names coincide.
      // These four do not, and a null registry means zero versions with a green build.
      expect(registryFor({ ecosystem: "rubygems" })).toBe("rubygems.org");
      expect(registryFor({ ecosystem: "go" })).toBe("proxy.golang.org");
      expect(registryFor({ ecosystem: "packagist" })).toBe("packagist.org");
      expect(registryFor({ ecosystem: "homebrew" })).toBe("formulae.brew.sh");
    });
  });

  describe("bad input", () => {
    it("falls back to the ecosystem when the purl will not parse", () => {
      expect(registryFor({ ecosystem: "npm", purl: "not-a-purl" })).toBe("npmjs.org");
    });

    it("returns null for an unknown ecosystem and no purl", () => {
      expect(registryFor({ ecosystem: "fakesystem" })).toBeNull();
    });

    it("returns null when there is nothing to go on", () => {
      expect(registryFor({})).toBeNull();
      expect(registryFor({ ecosystem: null, purl: null })).toBeNull();
    });

    it("does not resolve inherited Object properties", () => {
      // "constructor" is a valid purl type per the spec's grammar; a bare index lookup
      // would return Object itself -- truthy, typed string, interpolated into a URL.
      expect(registryFor({ ecosystem: "constructor" })).toBeNull();
      expect(registryFor({ ecosystem: "toString" })).toBeNull();
    });
  });
});
