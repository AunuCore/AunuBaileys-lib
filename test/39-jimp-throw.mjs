// Stand-in for an ABSENT optional peer (sharp / @napi-rs/image) in the
// HB-468 tests: importing this module throws, so
// getImageProcessingLibrary's `.catch(() => {})` yields undefined and
// the loader falls through to jimp.
throw new Error('stub: optional image backend unavailable')
