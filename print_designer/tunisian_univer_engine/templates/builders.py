# Blank document templates for the OnlyOffice workspace. Hardcoded designs
# live here: one builder function per design, registered in registry.py.

import io
import zipfile

_MINIMAL_DOCX_XML = {
	"[Content_Types].xml": (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
		'<Default Extension="xml" ContentType="application/xml"/>'
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
		"</Types>"
	),
	"_rels/.rels": (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
		"</Relationships>"
	),
	"word/document.xml": (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
		"<w:body><w:p/></w:body>"
		"</w:document>"
	),
}


def blank_xlsx() -> bytes:
	"""A blank workbook with a single empty sheet, built with openpyxl."""
	from openpyxl import Workbook

	buffer = io.BytesIO()
	Workbook().save(buffer)
	return buffer.getvalue()


def blank_docx() -> bytes:
	"""A minimal valid .docx (one empty paragraph) assembled with zipfile."""
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
		for name, xml in _MINIMAL_DOCX_XML.items():
			bundle.writestr(name, xml)
	return buffer.getvalue()
