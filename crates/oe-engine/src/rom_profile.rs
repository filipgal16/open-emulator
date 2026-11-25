//! Which ROM recipe a profile runs.

use oe_formats::recipe::{RomParams, RomRecipe};
use oe_formats::recipes::recipe_by_id;

use crate::env_file::GuestProfile;
use crate::host::GuestTuning;
use crate::{fail, Result};

/// The ROM recipe a profile runs, or `None` when its image is a stock one downloaded as-is.
///
/// A recipe's id is its image tag, so the profile names it with `PROFILE_IMAGE_TAG`. The profile
/// also states the base and the API level on its own, because the SDK paths and the download are
/// built from those before any recipe is consulted, and the two descriptions can drift. Running
/// on would read one image directory and build into another, so a disagreement fails here, naming
/// both.
pub fn recipe_for_profile(profile: &GuestProfile) -> Result<Option<RomRecipe>> {
    let Some(recipe) = recipe_by_id(&profile.image_tag) else {
        if let Some(base) = &profile.base_image_tag {
            fail!(
                "profile '{}' is built from the {base} image, but no ROM recipe is called '{}'",
                profile.name,
                profile.image_tag
            );
        }
        return Ok(None);
    };
    if profile.base_image_tag.as_deref() != Some(recipe.base_tag.as_str()) || recipe.api_level != profile.api_level {
        fail!(
            "profile '{}' says {} is API {} built from {}, but its recipe is API {} built from {}",
            profile.name,
            profile.image_tag,
            profile.api_level,
            profile.base_image_tag.as_deref().unwrap_or("nothing"),
            recipe.api_level,
            recipe.base_tag
        );
    }
    Ok(Some(recipe))
}

/// What the ROM is told about the guest it will run in: the core count is the very number written
/// to `hw.cpu.ncore`, taken from the same tuning, so the ARM translator's cpuinfo lists the cores
/// the guest actually has.
pub fn rom_params(tuning: &GuestTuning) -> RomParams {
    RomParams { arm_cpu_cores: Some(tuning.cores) }
}
