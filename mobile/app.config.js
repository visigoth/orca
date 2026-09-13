// Bundle identifier as an input, for the paths that never see fastlane.
//
// `mobile/fastlane/release_identity.rb` already lets a fork sign and upload as its own app, but
// that only covers the RELEASE path. `expo run:ios`, `expo prebuild`, and anything else driven by
// the Expo CLI never load fastlane at all -- they read this config, and through it `app.json`,
// where the identifier is upstream's. So a fork could release as itself but could not BUILD as
// itself, which is the wrong way round: building is the thing you do first and often.
//
// Expo hands the static `app.json` in as `config`, so an unset variable returns it untouched and
// an unconfigured checkout behaves exactly as before. Same variable name as the release path, so
// there is one thing to set rather than two:
//
//     IOS_BUNDLE_IDENTIFIER=com.example.orca pnpm ios
//
// The alternative was editing app.json in place. That works once, then has to be carried across
// every rebase and kept out of every commit, and it makes `git status` permanently dirty on the
// machine doing the builds.
module.exports = ({ config }) => {
  const bundleIdentifier = (process.env.IOS_BUNDLE_IDENTIFIER || '').trim()
  if (!bundleIdentifier) {
    return config
  }
  return {
    ...config,
    ios: { ...config.ios, bundleIdentifier }
  }
}
