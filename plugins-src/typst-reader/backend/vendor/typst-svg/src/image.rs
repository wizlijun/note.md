use base64::Engine;
use ecow::{EcoString, eco_format};
use image::{ImageEncoder, codecs::png::PngEncoder};
use typst_library::foundations::{Bytes, Smart};
use typst_library::layout::{Abs, Axes};
use typst_library::visualize::{
    ExchangeFormat, Image, ImageKind, ImageScaling, RasterFormat,
};

use crate::write::{SvgElem, SvgTransform, SvgWrite};
use crate::{SVGRenderer, State};

impl SVGRenderer<'_> {
    /// Render an image element.
    pub(super) fn render_image(
        &mut self,
        svg: &mut SvgElem,
        state: &State,
        image: &Image,
        size: &Axes<Abs>,
    ) {
        let url = WebImage::new(image).to_base64_url();
        let mut svg = svg.elem("image");
        if !state.transform.is_identity() {
            svg.attr("transform", SvgTransform(state.transform));
        }
        svg.attr("xlink:href", url.as_str());
        svg.attr("width", size.x.to_pt());
        svg.attr("height", size.y.to_pt());
        svg.attr("preserveAspectRatio", "none");
        if let Some(value) = convert_image_scaling(image.scaling()) {
            svg.attr_with("style", |attr| {
                attr.push_str("image-rendering: ");
                attr.push_str(value);
            });
        }
    }
}

/// Converts an image scaling to a CSS `image-rendering` property value.
pub fn convert_image_scaling(scaling: Smart<ImageScaling>) -> Option<&'static str> {
    match scaling {
        Smart::Auto => None,
        Smart::Custom(ImageScaling::Smooth) => {
            // This is still experimental and not implemented in all major browsers.
            // https://developer.mozilla.org/en-US/docs/Web/CSS/image-rendering#browser_compatibility
            Some("smooth")
        }
        Smart::Custom(ImageScaling::Pixelated) => Some("pixelated"),
    }
}

/// An image that is prepared for use in the web platform (SVG or HTML).
#[derive(Debug, Clone, Hash)]
pub struct WebImage {
    pub format: WebImageFormat,
    pub data: Bytes,
}

/// An image format supported on the web.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
#[non_exhaustive]
pub enum WebImageFormat {
    Png,
    Jpg,
    Gif,
    Webp,
    Svg,
}

impl WebImageFormat {
    /// The mime type for this format.
    pub fn mime(&self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
        }
    }

    /// The canonical extension used for this format.
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Svg => "svg",
        }
    }
}

impl WebImage {
    /// Prepare an image for embedding in SVG or HTML.
    #[comemo::memoize]
    pub fn new(image: &Image) -> WebImage {
        let (format, data) = match image.kind() {
            ImageKind::Raster(raster) => match raster.format() {
                RasterFormat::Exchange(format) => (
                    match format {
                        ExchangeFormat::Png => WebImageFormat::Png,
                        ExchangeFormat::Jpg => WebImageFormat::Jpg,
                        ExchangeFormat::Gif => WebImageFormat::Gif,
                        ExchangeFormat::Webp => WebImageFormat::Webp,
                    },
                    raster.data().clone(),
                ),
                RasterFormat::Pixel(_) => (WebImageFormat::Png, {
                    let mut buf = vec![];
                    let mut encoder = PngEncoder::new(&mut buf);
                    if let Some(icc_profile) = raster.icc() {
                        encoder.set_icc_profile(icc_profile.to_vec()).ok();
                    }
                    raster.dynamic().write_with_encoder(encoder).unwrap();
                    Bytes::new(buf)
                }),
            },
            ImageKind::Svg(svg) => (WebImageFormat::Svg, svg.data().clone()),
            ImageKind::Pdf(_) => unreachable!("PDF images are rejected by Typeset Reader"),
        };
        Self { format, data }
    }

    /// Turns the image into a base64 URL.
    ///
    /// The format of the URL is `data:{mime};base64,`.
    #[comemo::memoize]
    pub fn to_base64_url(&self) -> EcoString {
        let mut url = eco_format!("data:{};base64,", self.format.mime());
        let data = base64::engine::general_purpose::STANDARD.encode(&self.data);
        url.push_str(&data);
        url
    }
}
