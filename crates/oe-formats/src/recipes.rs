//! Every ROM this build of the app can make, by id. The id is also the image's SDK tag, which is
//! how a profile names its ROM: `PROFILE_IMAGE_TAG=openemu-compat` selects the recipe of that id.

use crate::recipe::{openemu_recipe, RomRecipe};
use crate::recipe_compat::openemu_compat_recipe;

/// Every recipe, `openemu` first.
pub fn rom_recipes() -> Vec<RomRecipe> {
    vec![openemu_recipe(), openemu_compat_recipe()]
}

/// The recipe with this id, or `None` — an image tag that is not one of ours is a stock image.
pub fn recipe_by_id(id: &str) -> Option<RomRecipe> {
    rom_recipes().into_iter().find(|recipe| recipe.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn a_recipe_is_found_by_its_id_which_is_also_its_image_tag() {
        assert_eq!(recipe_by_id("openemu"), Some(openemu_recipe()));
        assert_eq!(recipe_by_id("openemu-compat"), Some(openemu_compat_recipe()));
        let mut ids: Vec<String> = rom_recipes().into_iter().map(|r| r.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["openemu", "openemu-compat"]);
    }

    #[test]
    fn a_stock_image_tag_is_not_a_recipe() {
        for tag in ["default", "google_apis", "google_apis_playstore", "", "toString", "constructor", "__proto__"] {
            assert_eq!(recipe_by_id(tag), None, "{tag}");
        }
    }

    #[test]
    fn no_two_recipes_build_into_the_same_image_directory() {
        let dirs: Vec<String> = rom_recipes().iter().map(|r| format!("android-{}/{}", r.api_level, r.id)).collect();
        assert_eq!(dirs.iter().collect::<HashSet<_>>().len(), dirs.len());
    }
}
