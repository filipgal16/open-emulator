//! The guest images a user can choose between, described the way a person would ask for them.
//!
//! These mirror `android/profiles/*.env`; the ids are those file names.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProfileId {
    Openemu,
    OpenemuCompat,
    Fast,
    Full,
    Play,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileSpec {
    pub id: ProfileId,
    pub label: &'static str,
    /// One line, in the user's terms, not "google_apis_playstore;x86_64".
    pub description: &'static str,
    pub play_store: bool,
    /// Roughly what the one-time download costs, so the choice is informed.
    pub download_hint: &'static str,
    /// Whether the image carries Google Mobile Services. Surfaced in the picker because it decides
    /// more than which apps run: a GMS image cannot be redistributed. See LICENSING.md.
    pub proprietary: bool,
}

impl ProfileId {
    pub const ALL: [ProfileId; 5] = [ProfileId::Openemu, ProfileId::OpenemuCompat, ProfileId::Fast, ProfileId::Full, ProfileId::Play];

    /// The id as the `.env` file and `settings.json` spell it.
    pub fn id(self) -> &'static str {
        match self {
            ProfileId::Openemu => "openemu",
            ProfileId::OpenemuCompat => "openemu-compat",
            ProfileId::Fast => "fast",
            ProfileId::Full => "full",
            ProfileId::Play => "play",
        }
    }

    pub fn parse(value: &str) -> Option<ProfileId> {
        ProfileId::ALL.into_iter().find(|profile| profile.id() == value)
    }

    pub fn spec(self) -> ProfileSpec {
        match self {
            ProfileId::Openemu => ProfileSpec {
                id: self,
                label: "open-emulator",
                description: "Our own build of Android: the stock image debloated, tuned and branded for this emulator. No Google Play.",
                play_store: false,
                // Built from the Fast image, so it costs nothing extra once that is downloaded.
                download_hint: "built from Fast, no extra download",
                proprietary: false,
            },
            ProfileId::OpenemuCompat => ProfileSpec {
                id: self,
                label: "open-emulator Android (Google APIs)",
                description: "Our own build of Android 14 that runs ARM games, with Google Play Services for sign-in. No Play Store app.",
                play_store: false,
                download_hint: "Android 14 image, then built on this PC",
                // Derived from the google_apis image and keeps GMS.
                proprietary: true,
            },
            ProfileId::Fast => ProfileSpec {
                id: self,
                label: "Fast",
                description: "Plain Android. Boots quickest. No Google Play.",
                play_store: false,
                download_hint: "about 4 GB",
                proprietary: false,
            },
            ProfileId::Full => ProfileSpec {
                id: self,
                label: "Google apps",
                description: "Adds Google Play Services, for apps that need them. Still no Play Store app.",
                play_store: false,
                download_hint: "about 4 GB",
                proprietary: true,
            },
            ProfileId::Play => ProfileSpec {
                id: self,
                label: "Play Store",
                description: "Google Play Store built in. Sign in and install apps normally. Slowest to start.",
                play_store: true,
                download_hint: "about 4 GB extra",
                proprietary: true,
            },
        }
    }
}

impl std::fmt::Display for ProfileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_profile_has_a_shipped_env_file_of_the_same_name() {
        let profiles = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../android/profiles");
        for profile in ProfileId::ALL {
            assert!(profiles.join(format!("{}.env", profile.id())).exists(), "{profile}");
            assert_eq!(ProfileId::parse(profile.id()), Some(profile));
        }
        assert_eq!(ProfileId::parse("nope"), None);
    }
}
