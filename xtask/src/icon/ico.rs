//! The Windows `.ico` container, with PNG-compressed images (supported since Vista).
//!
//! An ICO is a 6-byte header (reserved 0, type 1, image count), then one 16-byte directory entry
//! per image, then the images. A width or height of 256 is stored as 0, because the field is one
//! byte.

/// One image of the icon: its side in pixels and a complete PNG file.
pub struct IcoImage {
    pub size: usize,
    pub png: Vec<u8>,
}

pub fn encode(images: &[IcoImage]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&u16::try_from(images.len()).map_err(|_| "too many icon images")?.to_le_bytes());
    let mut offset = 6 + 16 * images.len();
    for image in images {
        if !(1..=256).contains(&image.size) {
            return Err(format!("an icon image cannot be {} px", image.size));
        }
        let side = if image.size == 256 { 0 } else { image.size as u8 };
        out.extend_from_slice(&[side, side, 0, 0]); // colour count and reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // colour planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        out.extend_from_slice(&u32::try_from(image.png.len()).map_err(|_| "icon image too large")?.to_le_bytes());
        out.extend_from_slice(&u32::try_from(offset).map_err(|_| "icon too large")?.to_le_bytes());
        offset += image.png.len();
    }
    for image in images {
        out.extend_from_slice(&image.png);
    }
    Ok(out)
}

/// Reads an ICO back into its images, checking the header and that every entry lies inside the
/// file. Used by the tests: an icon Windows cannot load is only found out at install time.
#[cfg(test)]
pub fn parse(data: &[u8]) -> Result<Vec<IcoImage>, String> {
    let u16_at = |at: usize| data.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |at: usize| data.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if u16_at(0) != Some(0) || u16_at(2) != Some(1) {
        return Err("not an ICO: bad reserved/type fields".into());
    }
    let count = u16_at(4).ok_or("truncated ICO header")? as usize;
    let mut images = Vec::new();
    for n in 0..count {
        let at = 6 + n * 16;
        let entry = data.get(at..at + 16).ok_or("truncated ICO directory")?;
        let size = if entry[0] == 0 { 256 } else { usize::from(entry[0]) };
        let length = u32_at(at + 8).ok_or("truncated ICO directory")? as usize;
        let offset = u32_at(at + 12).ok_or("truncated ICO directory")? as usize;
        let png = data.get(offset..offset + length).ok_or("an ICO entry points outside the file")?;
        images.push(IcoImage { size, png: png.to_vec() });
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_round_trip_and_256_is_stored_as_zero() {
        let images = vec![IcoImage { size: 16, png: vec![1, 2, 3] }, IcoImage { size: 256, png: vec![4, 5] }];
        let data = encode(&images).unwrap();
        assert_eq!(&data[..6], &[0, 0, 1, 0, 2, 0]);
        assert_eq!(data[6], 16);
        assert_eq!(data[22], 0, "256 is stored as 0");
        let back = parse(&data).unwrap();
        assert_eq!((back[0].size, &back[0].png[..]), (16, &[1u8, 2, 3][..]));
        assert_eq!((back[1].size, &back[1].png[..]), (256, &[4u8, 5][..]));
    }

    #[test]
    fn a_truncated_file_is_an_error_and_a_bad_size_is_refused() {
        let data = encode(&[IcoImage { size: 32, png: vec![9; 10] }]).unwrap();
        assert!(parse(&data[..data.len() - 1]).is_err());
        assert!(encode(&[IcoImage { size: 300, png: vec![] }]).is_err());
    }
}
