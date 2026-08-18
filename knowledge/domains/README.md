# Corpus curado por domínio

O diretório `legaltech_lgpd/` aceita arquivos JSON revisados por humano.
Não adicione texto gerado por LLM como fonte. Cada objeto deve conter:

`id`, `title`, `domain`, `sourceTitle`, `sourceUrl`, `reviewedBy`, `reviewedAt`, `content`, `tags`.

Sem documentos válidos, o runtime declara que não há corpus e proíbe usar conhecimento do modelo
como evidência jurídica ou regulatória.
