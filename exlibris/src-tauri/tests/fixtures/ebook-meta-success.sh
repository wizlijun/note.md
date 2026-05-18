#!/usr/bin/env bash
cat <<'OPF'
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Hello World</dc:title>
    <dc:creator opf:role="aut">Jane Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier opf:scheme="ISBN">9780000000001</dc:identifier>
    <dc:subject>computers</dc:subject>
    <dc:subject>programming</dc:subject>
    <dc:date>2024-01-15</dc:date>
    <dc:description>A test book.</dc:description>
  </metadata>
</package>
OPF
exit 0
