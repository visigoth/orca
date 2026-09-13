# Which app a release signs, uploads to, and distributes from — as inputs, not constants.
#
# Why this is not just a hardcoded bundle id: com.stably.orca.mobile is one team's App Store
# record. Anyone can build this app from a fork, but no fork can ever upload to that record, so
# building it means signing a different bundle id against a different App Store Connect app whose
# beta groups are also its own. Reading both from the environment lets a fork release itself
# without a patch it has to carry forever, while an unconfigured checkout releases exactly as
# before.
module ReleaseIdentity
  DEFAULT_BUNDLE_ID = "com.stably.orca.mobile".freeze
  DEFAULT_TESTFLIGHT_GROUPS = ["peeps"].freeze

  module_function

  # Why blank counts as unset: an unset GitHub Actions `vars.*` expands to an empty string, so the
  # variable is present and ENV.fetch's default never fires. Without this, merely referencing the
  # variable in a workflow would make every upstream release sign a bundle id of "".
  def bundle_id(env = ENV)
    presence(env["IOS_BUNDLE_IDENTIFIER"]) || DEFAULT_BUNDLE_ID
  end

  # Comma-separated, because a workflow variable is a string and a release can target more than
  # one group.
  def testflight_groups(env = ENV)
    raw = presence(env["TESTFLIGHT_GROUPS"])
    return DEFAULT_TESTFLIGHT_GROUPS unless raw

    groups = raw.split(",").filter_map { |group| presence(group) }
    # An all-separator value ("," or " , ") is a typo, not a request to distribute to nobody --
    # and distribute_testflight treats an empty group list as "no groups missing", so it would
    # sail past the guard and upload to no one.
    groups.empty? ? DEFAULT_TESTFLIGHT_GROUPS : groups.freeze
  end

  def presence(value)
    stripped = value.to_s.strip
    stripped.empty? ? nil : stripped
  end
end
