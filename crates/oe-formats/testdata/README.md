# Test data

- `ext4-fixture.img.gz`: a small ext4 volume with exactly the feature set of the logical
  partitions inside Google's API 30 `system.img`. It has more than one block group (the groups are
  small, so the image stays tiny), a file whose blocks two inodes share, an htree directory, an
  uninitialised group and an in-inode extended attribute. The ext4 editor's tests run against it.
  It was made once with `mke2fs` and is committed as it is: nothing in the build or the tests
  regenerates it.
- `build.prop.*`: the four `build.prop` files of the stock API 30 image, byte for byte. Kept with
  their original line endings (see `.gitattributes`).
