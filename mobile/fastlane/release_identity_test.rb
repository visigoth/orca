require "minitest/autorun"
require_relative "release_identity"

# Why these are worth pinning: both values decide which App Store Connect app a release touches.
# Getting them wrong does not fail locally -- it fails 30 minutes into a release, against someone
# else's app record.
class ReleaseIdentityTest < Minitest::Test
  def test_defaults_to_the_upstream_app_when_nothing_is_configured
    assert_equal("com.stably.orca.mobile", ReleaseIdentity.bundle_id({}))
    assert_equal(["peeps"], ReleaseIdentity.testflight_groups({}))
  end

  def test_a_fork_can_sign_and_distribute_its_own_app
    env = { "IOS_BUNDLE_IDENTIFIER" => "com.example.orca", "TESTFLIGHT_GROUPS" => "internal" }

    assert_equal("com.example.orca", ReleaseIdentity.bundle_id(env))
    assert_equal(["internal"], ReleaseIdentity.testflight_groups(env))
  end

  # An unset GitHub Actions `vars.*` expands to "", so a workflow that merely references the
  # variable would otherwise make every upstream release sign an empty bundle id.
  def test_an_unset_workflow_variable_reads_as_unset_not_as_empty
    env = { "IOS_BUNDLE_IDENTIFIER" => "", "TESTFLIGHT_GROUPS" => "" }

    assert_equal("com.stably.orca.mobile", ReleaseIdentity.bundle_id(env))
    assert_equal(["peeps"], ReleaseIdentity.testflight_groups(env))
  end

  def test_surrounding_whitespace_does_not_become_part_of_the_identity
    env = { "IOS_BUNDLE_IDENTIFIER" => "  com.example.orca  ", "TESTFLIGHT_GROUPS" => " a , b " }

    assert_equal("com.example.orca", ReleaseIdentity.bundle_id(env))
    assert_equal(%w[a b], ReleaseIdentity.testflight_groups(env))
  end

  # distribute_testflight guards on TESTFLIGHT_GROUPS - available_groups, which is empty for an
  # empty list -- so a separators-only value would pass the guard and then distribute to no one.
  def test_a_groups_value_with_no_groups_in_it_falls_back_rather_than_distributing_to_nobody
    assert_equal(["peeps"], ReleaseIdentity.testflight_groups({ "TESTFLIGHT_GROUPS" => " , " }))
  end
end
